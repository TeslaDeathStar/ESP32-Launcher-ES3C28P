#!/usr/bin/env python3
"""Analyze Launcher binaries against the test/factory partition in the embedded partition table."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

GITHUB_REPO = "bmorcelli/Launcher"
PART_TABLE_OFFSET = 0x8000
PART_TABLE_SIZE = 0x1000
ENTRY_SIZE = 32
APP_TYPE = 0x00
APP_SUBTYPE_NAMES = {
    0x00: "factory",
    0x10: "ota_0",
    0x11: "ota_1",
    0x12: "ota_2",
    0x13: "ota_3",
    0x14: "ota_4",
    0x15: "ota_5",
    0x16: "ota_6",
    0x17: "ota_7",
    0x18: "ota_8",
    0x19: "ota_9",
    0x20: "test",
}
DEFAULT_TAG = "beta"


@dataclass
class PartitionEntry:
    type_: int
    subtype: int
    label: str
    offset: int
    size: int
    flags: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze Launcher .bin files against the embedded test/factory partition."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--on-folder",
        metavar="folder",
        help="Analyze all .bin files inside the given folder.",
    )
    group.add_argument(
        "--on-tag",
        nargs="?",
        const=DEFAULT_TAG,
        metavar="tag",
        help=f"Download all .bin assets from the GitHub release tag and analyze them (default: {DEFAULT_TAG}).",
    )
    parser.add_argument(
        "--output",
        metavar="file",
        help="Write the table and any errors to the given file, in addition to printing to the console.",
    )
    return parser.parse_args()


def github_api_get(path: str) -> dict:
    token = os.environ.get("GITHUB_TOKEN")
    url = f"https://api.github.com/repos/{GITHUB_REPO}/{path}"
    headers = {
        "User-Agent": "Launcher-size-analysis",
        "Accept": "application/vnd.github+json",
    }
    if token:
        headers["Authorization"] = f"token {token}"

    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read()
            return json.loads(body.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API request failed: {exc.code} {exc.reason} {message}")


def download_url(url: str, dest: Path) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    headers = {"User-Agent": "Launcher-size-analysis"}
    if token:
        headers["Authorization"] = f"token {token}"

    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request) as response:
        dest.write_bytes(response.read())


def list_release_assets(tag: str) -> List[dict]:
    release = github_api_get(f"releases/tags/{urllib.parse.quote(tag)}")
    assets = release.get("assets", [])
    if not assets:
        raise RuntimeError(f"Release '{tag}' has no assets")
    return assets


def download_release_binaries(tag: str) -> Path:
    print(f"Downloading .bin assets from release '{tag}'...")
    assets = list_release_assets(tag)
    bin_assets = [a for a in assets if a.get("name", "").lower().endswith(".bin")]
    if not bin_assets:
        raise RuntimeError(f"Release '{tag}' has no .bin assets")

    temp_dir = Path(tempfile.mkdtemp(prefix="launcher-size-analysis-"))
    print(f"Downloading {len(bin_assets)} artifacts into {temp_dir}")
    for asset in bin_assets:
        url = asset.get("browser_download_url")
        name = asset.get("name")
        if not url or not name:
            continue
        dest = temp_dir / name
        print(f" - {name}")
        download_url(url, dest)
    return temp_dir


def read_partition_table(file_path: Path) -> bytes:
    with file_path.open("rb") as handle:
        handle.seek(PART_TABLE_OFFSET)
        table = handle.read(PART_TABLE_SIZE)
    if len(table) < ENTRY_SIZE:
        raise ValueError("Partition table region is missing or truncated")
    return table


def parse_partition_entries(table: bytes) -> List[PartitionEntry]:
    entries: List[PartitionEntry] = []
    for offset in range(0, min(len(table), PART_TABLE_SIZE), ENTRY_SIZE):
        raw = table[offset : offset + ENTRY_SIZE]
        if len(raw) < ENTRY_SIZE:
            break

        if raw[:2] == b"\xaaP":
            type_ = raw[2]
            subtype = raw[3]
            partition_offset = int.from_bytes(raw[4:8], "little")
            size = int.from_bytes(raw[8:12], "little")
            label = raw[12:28].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
            flags = int.from_bytes(raw[28:32], "little")
        else:
            type_ = raw[0]
            subtype = raw[1]
            label = raw[2:18].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
            partition_offset = int.from_bytes(raw[18:22], "little")
            size = int.from_bytes(raw[22:26], "little")
            flags = int.from_bytes(raw[26:30], "little")

        if type_ == 0xFF or (type_ == 0x00 and size == 0 and partition_offset == 0):
            continue
        entries.append(
            PartitionEntry(
                type_=type_,
                subtype=subtype,
                label=label,
                offset=partition_offset,
                size=size,
                flags=flags,
            )
        )
    return entries


def find_target_partition(entries: List[PartitionEntry]) -> Optional[PartitionEntry]:
    best: Optional[PartitionEntry] = None
    for entry in entries:
        if entry.type_ != APP_TYPE:
            continue
        subtype_name = APP_SUBTYPE_NAMES.get(entry.subtype, "")
        if subtype_name == "test":
            return entry
        if subtype_name == "factory" and best is None:
            best = entry
    if best:
        return best

    # Fallback: also check label names if a custom partition table encoded them differently.
    for entry in entries:
        label_name = entry.label.strip().lower()
        if label_name in {"test", "factory"}:
            return entry
    return None


def format_rows(rows: List[Tuple[str, str, str, str]]) -> str:
    widths = [0, 0, 0, 0]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    header = ["filename", "used %", "PartSize", "Free"]
    widths = [max(widths[idx], len(header[idx])) for idx in range(4)]
    sep = "| " + " | ".join("-" * width for width in widths) + " |"
    lines = [
        "| " + " | ".join(header[idx].ljust(widths[idx]) for idx in range(4)) + " |",
        sep,
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(row[idx].ljust(widths[idx]) for idx in range(4))
            + " |"
        )
    return "\n".join(lines)


def analyze_files(files: Iterable[Path], output_file: Optional[Path] = None) -> List[Tuple[str, str, str, str]]:
    rows: List[Tuple[str, str, str, str]] = []
    errors: List[str] = []
    for file_path in sorted(files, key=lambda p: p.name.lower()):
        display_name = file_path.name.removeprefix("Launcher-")
        try:
            table_data = read_partition_table(file_path)
            entries = parse_partition_entries(table_data)
            entry = find_target_partition(entries)
            if entry is None:
                raise ValueError("no test/factory app partition found")
            file_size = file_path.stat().st_size
            partition_end = entry.offset + entry.size
            used_pct = (file_size / partition_end * 100.0) if partition_end else 0.0
            free_bytes = max(0, partition_end - file_size)
            rows.append(
                (
                    display_name,
                    f"{used_pct:.1f}%",
                    f"0x{entry.size:X}",
                    f"0x{free_bytes:X}",
                )
            )
        except Exception as exc:
            rows.append((display_name, "ERROR", "", str(exc)))
            errors.append(f"{display_name}: {exc}")
    if not rows:
        raise RuntimeError("No .bin files found for analysis")

    def sort_key(row: Tuple[str, str, str, str]) -> float:
        if row[1].endswith("%"):
            try:
                return float(row[1][:-1])
            except ValueError:
                return -1.0
        return -1.0

    rows.sort(key=sort_key, reverse=True)
    table_text = format_rows(rows)
    print(table_text)

    error_text = ""
    if errors:
        error_text = "\nErrors:\n" + "\n".join(errors)
        print(error_text, file=sys.stderr)

    if output_file:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with output_file.open("w", encoding="utf-8") as fh:
            fh.write(table_text)
            if error_text:
                fh.write("\n\n")
                fh.write(error_text)
        print(f"Analysis written to {output_file}")

    return rows


def main() -> int:
    args = parse_args()
    output_file = Path(args.output) if args.output else None
    if args.on_folder:
        folder = Path(args.on_folder)
        if not folder.exists() or not folder.is_dir():
            raise SystemExit(f"Folder not found: {folder}")
        files = list(folder.glob("*.bin"))
        if not files:
            raise SystemExit(f"No .bin files found in {folder}")
        analyze_files(files, output_file=output_file)
        return 0

    if args.on_tag is not None:
        tag = args.on_tag or DEFAULT_TAG
        download_dir = download_release_binaries(tag)
        try:
            files = list(download_dir.glob("*.bin"))
            if not files:
                raise SystemExit(f"No .bin assets downloaded for release '{tag}'")
            analyze_files(files, output_file=output_file)
        finally:
            pass
        return 0

    raise SystemExit("Either --on-folder or --on-tag must be provided.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
