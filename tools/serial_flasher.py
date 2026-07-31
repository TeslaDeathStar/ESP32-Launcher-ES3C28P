#!/usr/bin/env python3
"""Flash a firmware .bin into the Launcher over the Serial Monitor command
interface (see src/serial_console.cpp), instead of the SD card or Web UI.

Usage:
    python3 serial_flasher.py -f <path to file.bin> -p <serial port, e.g. COM21>

What it does:
    1. Uses esptool to reset the board so it reboots (unplugging/replugging works too).
    2. Watches the serial output for the Launcher's boot banner
       ("Press the button to enter the Launcher!") and immediately sends
       "nav SelPress" so the Launcher menu comes up instead of auto-booting
       whatever OTA firmware is queued.
    3. Detects whether the .bin is a merged image (bootloader + partition table +
       app [+ data], as produced by esptool's merge_bin/PlatformIO's merge step)
       and, if so, extracts just the app image portion instead of sending the
       whole file — mirrors the detection in src/sd_functions.cpp/webUi/scripts.js.
    4. Sends "flash firmware <name> <size>" and waits for the "READY <size>"
       reply, then streams just the app image bytes.
    5. Waits for the final "OK"/"ERR" line and reports the result.
"""

import argparse
import os
import struct
import subprocess
import sys
import time

# The device may emit a stray byte mid-UTF-8-sequence right when the serial
# port is opened; decode(errors="replace") turns that into U+FFFD, which some
# Windows consoles (cp1252) can't print. Make stdout tolerant of that instead
# of crashing the whole flash run over a cosmetic log line.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

try:
    import serial
except ImportError:
    sys.exit("Missing dependency 'pyserial'. Install it with: pip install pyserial")

BOOT_BANNER = "Press the button to enter the Launcher!"
READY_PREFIX = "READY"
PROGRESS_PREFIX = "PROGRESS"

# --- Merged-image detection, ported from src/sd_functions.cpp (updateFromSD /
# measureSdEspImage) and webUi/scripts.js (analyzeFile / measureEspImageSize).
# Keep this in sync if that C++/JS logic ever changes.

ESP_IMAGE_HEADER_MAGIC = 0xE9
ESP_IMAGE_MAX_SEGMENTS = 16
ESP_IMAGE_HASH_LEN = 32
PART_TABLE_OFFSET = 0x8000
PART_TABLE_SIZE = 0x1000
PART_ENTRY_SIZE = 0x20


def _align_up(value, alignment):
    return ((value + alignment - 1) // alignment) * alignment


def measure_esp_image_size(data, image_offset):
    """Walks an ESP app image's segment headers to find its true end offset
    (declared partition sizes are a ceiling; the real image is usually shorter).
    Returns 0 if there's no valid image header at image_offset."""
    if image_offset + 24 > len(data):
        return 0
    magic = data[image_offset]
    segment_count = data[image_offset + 1]
    hash_appended = data[image_offset + 23]
    if magic != ESP_IMAGE_HEADER_MAGIC or segment_count == 0 or segment_count > ESP_IMAGE_MAX_SEGMENTS:
        return 0
    cursor = image_offset + 24
    for _ in range(segment_count):
        if cursor + 8 > len(data):
            return 0
        segment_size = struct.unpack_from("<I", data, cursor + 4)[0]
        cursor += 8
        if segment_size > len(data) or cursor > len(data) - segment_size:
            return 0
        cursor += segment_size
    end = _align_up(cursor, 16) + 1
    if hash_appended:
        end += ESP_IMAGE_HASH_LEN
    end = _align_up(end, 16)
    if end <= image_offset or end > len(data):
        return 0
    return end - image_offset


def detect_app_region(data):
    """Returns (app_offset, app_size, is_merged). A merged image (bootloader +
    partition table + app [+ data]) is identified by the ESP_PARTITION_MAGIC
    (0xAA 0x50) + type=0x01 bytes at file offset 0x8000, matching the live
    on-flash partition table format; otherwise the file is a bare app image."""
    if (
        len(data) >= PART_TABLE_OFFSET + 3
        and data[PART_TABLE_OFFSET] == 0xAA
        and data[PART_TABLE_OFFSET + 1] == 0x50
        and data[PART_TABLE_OFFSET + 2] == 0x01
    ):
        app_offset, app_size = 0, 0
        for i in range(0, PART_TABLE_SIZE, PART_ENTRY_SIZE):
            pos = PART_TABLE_OFFSET + i
            entry = data[pos : pos + 32]
            if len(entry) < 32:
                break
            if (entry[0] == 0xEB and entry[1] == 0xEB) or (entry[0] == 0xFF and entry[1] == 0xFF):
                break
            ptype, subtype = entry[2], entry[3]
            offset = struct.unpack_from("<I", entry, 4)[0]
            declared_size = struct.unpack_from("<I", entry, 8)[0]
            if ptype == 0x00 and subtype in (0x00, 0x10, 0x20) and app_size == 0:
                app_offset = offset or 0x10000
                measured = measure_esp_image_size(data, app_offset)
                app_size = declared_size
                if len(data) < app_offset + app_size:
                    app_size = len(data) - app_offset
                if measured > 0 and (app_size == 0 or measured < app_size):
                    app_size = measured
        return app_offset, app_size, True
    app_size = measure_esp_image_size(data, 0) or len(data)
    return 0, app_size, False


def reset_board(port):
    """Reset the board via esptool so it reboots into the Launcher's bootscreen."""
    print(f"[*] Resetting board on {port} via esptool...")
    cmd = [sys.executable, "-m", "esptool", "--port", port, "--after", "hard_reset", "run"]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("esptool not found. Install it with: pip install esptool")
    except subprocess.CalledProcessError as exc:
        print(exc.stdout)
        print(exc.stderr)
        sys.exit(f"esptool failed to reset the board: {exc}")


class LineReader:
    """Buffers partial reads across calls so a line that arrives in the same
    chunk as (but after) the one a caller was waiting for is never dropped."""

    def __init__(self, ser):
        self.ser = ser
        self.buf = b""

    def wait_for_line(self, predicate, timeout, echo=True):
        deadline = time.time() + timeout
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                text = line.decode(errors="replace").rstrip("\r")
                if echo and text:
                    print(f"    < {text}")
                if predicate(text):
                    return text
            if time.time() >= deadline:
                return None
            chunk = self.ser.read(self.ser.in_waiting or 1)
            if chunk:
                self.buf += chunk


def send_command(ser, command):
    print(f"[*] > {command}")
    ser.write((command + "\n").encode())
    ser.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-f", "--file", required=True, help="Path to the firmware .bin to flash")
    parser.add_argument("-p", "--port", required=True, help="Serial port, e.g. COM21 or /dev/ttyUSB0")
    parser.add_argument("-b", "--baud", type=int, default=115200, help="Serial baud rate (default 115200)")
    parser.add_argument("-n", "--name", default=None, help="App name to register (default: file name)")
    parser.add_argument(
        "--no-reset", action="store_true", help="Skip the esptool reset step (board is already at the bootscreen)"
    )
    parser.add_argument(
        "--boot-timeout", type=float, default=15.0, help="Seconds to wait for the Launcher boot banner"
    )
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        sys.exit(f"File not found: {args.file}")
    name = args.name or os.path.splitext(os.path.basename(args.file))[0]

    with open(args.file, "rb") as fh:
        file_data = fh.read()
    app_offset, size, is_merged = detect_app_region(file_data)
    if size == 0:
        sys.exit(f"Could not find a valid app image in {args.file}")
    if is_merged:
        print(
            f"[*] Detected merged image (bootloader+partitions+app); "
            f"flashing app portion only: offset=0x{app_offset:x} size={size} bytes"
        )
    else:
        print(f"[*] Detected plain app image: size={size} bytes")
    app_data = file_data[app_offset : app_offset + size]

    if not args.no_reset:
        reset_board(args.port)

    print(f"[*] Opening {args.port} @ {args.baud}...")
    with serial.Serial(args.port, args.baud, timeout=0.2) as ser:
        reader = LineReader(ser)
        print("[*] Waiting for the Launcher boot banner...")
        banner = reader.wait_for_line(lambda line: BOOT_BANNER in line, args.boot_timeout)
        if banner is None:
            sys.exit("Timed out waiting for the Launcher boot banner. Is the board running this firmware?")

        send_command(ser, "nav SelPress")
        time.sleep(0.3)

        print(f"[*] Flashing '{name}' ({size} bytes)...")
        send_command(ser, f"flash firmware {name} {size}")

        reply = reader.wait_for_line(lambda line: line.startswith(READY_PREFIX) or line.startswith("ERR"), 10.0)
        if reply is None:
            sys.exit("Timed out waiting for READY from the device.")
        if reply.startswith("ERR"):
            sys.exit(f"Device rejected the flash request: {reply}")

        print("[*] Streaming firmware bytes...")
        data = app_data
        # Send one chunk, then wait for the device's ACK before sending the next.
        # A blind multi-second single write was observed to silently stall a few
        # percent short of completion on some Windows USB-serial drivers; keeping
        # only one chunk in flight at a time avoids that class of issue entirely.
        chunk_size = 2048
        sent = 0
        last_report = time.time()
        while sent < len(data):
            chunk = data[sent : sent + chunk_size]
            ser.write(chunk)
            ser.flush()
            sent += len(chunk)

            ack = reader.wait_for_line(
                lambda line: line.startswith("ACK") or line.startswith("ERR"), timeout=15.0, echo=False
            )
            if ack is None:
                sys.exit(f"Timed out waiting for ACK at {sent}/{len(data)} bytes.")
            if ack.startswith("ERR"):
                sys.exit(f"Device reported an error at {sent}/{len(data)} bytes: {ack}")

            if time.time() - last_report > 1.0:
                print(f"    > {sent}/{len(data)} bytes")
                last_report = time.time()

        result = reader.wait_for_line(lambda line: line.startswith("OK") or line.startswith("ERR"), timeout=60.0)
        if result is None:
            sys.exit("Timed out waiting for the flash result.")
        if result.startswith("ERR"):
            sys.exit(f"Flash failed: {result}")

        print(f"[+] Success: {result}")
        print("[*] Device is rebooting into the new firmware.")


if __name__ == "__main__":
    main()
