# Morning Star / Amy companion

The Launcher now includes an `AMY` menu entry. It keeps the normal Launcher
running and opens a small, text-only companion client for the Morning Star
gateway.

## What it does

- Uses the saved Launcher Wi-Fi connection and the built-in touch keyboard.
- Sends a prompt to `POST /api/device/chat` and displays Amy's reply.
- Stores the gateway URL and optional device token in ESP32 NVS.
- Sends no Home Assistant, terminal, file, firmware, or other device-control
  requests. The gateway endpoint is deliberately a separate, text-only API.

The default gateway is the private LAN address `http://10.0.2.218:8788`.
Choose `AMY` → `Connection` on the device to change it or enter a token before
using a public hostname.

## Build and flash

Use PlatformIO with Python 3.10 or newer:

```sh
pio run -e ES3C28P
pio run -e ES3C28P -t upload
```

The first integration is text-only. The ES3C28P microphone/speaker path can
be added separately after the network and UI path is proven; it requires an
ES8311/I2S audio driver and a streaming protocol rather than the short HTTP
request used here.

The board's documented audio wiring is reserved for that follow-up: amplifier
enable `IO1`, codec MCLK `IO4`, BCLK `IO5`, speaker data `IO6`, LRCK `IO7`, and
microphone data `IO8`. The display/touch path remains independent.

A verified factory image from the current checkout is also kept in the
Morning Star workspace as [Launcher-ES3C28P-amy.bin](</Users/null/Documents/ChatGPT/Frank's Macbook Air M2 Setup/amy-assistant/artifacts/Launcher-ES3C28P-amy.bin>).
Flash it only after confirming the board is the ES3C28P; it replaces the
currently installed firmware, as any full Launcher image does.

## Public deployment safety

Do not expose port 8788 directly. Keep the gateway bound to loopback and put
`amy.lokilee.com` behind an authenticated Cloudflare Tunnel. Configure a
device token in the gateway before allowing the hostname to reach it, then
enter the same token in `AMY` → `Connection`.
