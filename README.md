# PinGrab — Pinterest Downloader

A small self-hosted website that downloads the media from any Pinterest pin — **videos as MP4** and **images at full resolution**. Paste a pin link, pick a file, save.

![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Video pins → MP4.** Grabs every MP4 rendition Pinterest exposes (720p, etc.).
- **HLS-only pins are handled.** If Pinterest only offers a streaming playlist, the MP4 is derived and verified automatically so you still get a real `.mp4`.
- **Image pins at original resolution** (including carousel images).
- **Embedded video detection** — flags YouTube / Vimeo / TikTok / Facebook pins that aren't hosted on Pinterest.
- Works with `pinterest.com` and localized domains (`uk.`, `id.`, `br.`, …), `/pin/` and `/idea/` links, and `pin.it` short links.
- Clean, responsive web UI with a video preview and per-file download buttons.
- No API keys, no login, no database.

## Requirements

- [Node.js](https://nodejs.org/) **18.17 or newer** (uses the built-in `fetch`). Check with `node --version`.

## Install

```bash
git clone https://github.com/dzlover1/pinterest-downloader.git
cd pinterest-downloader
npm install
```

## Run

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

To use a different port:

```bash
# Windows PowerShell
$env:PORT=8080; npm start

# macOS / Linux
PORT=8080 npm start
```

## How to use

1. Open a pin on Pinterest and copy its URL from the address bar (or the Share button). It looks like
   `https://www.pinterest.com/pin/123456789012345678/`.
2. Paste it into the box on the page and click **Grab it**.
3. Review the preview, then click **Download MP4** (or the per-file **Save** buttons) to download.
4. Every file is saved straight from Pinterest through the local server with a proper filename.

## Project structure

```
pinterest-downloader/
├── server.js            # Express server + API routes + download proxy
├── src/
│   ├── pinterest.js     # Extractor: PinResource API → HTML state → raw scan
│   ├── urls.js          # URL validation + host allowlists (SSRF guard)
│   └── errors.js        # User-facing error type
├── public/              # Front-end (vanilla HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── package.json
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/resolve?url=<pin-url>` | Returns pin metadata plus a `media` array of downloadable files. |
| `GET /api/download?src=<media-url>&name=<filename>` | Streams a Pinterest media file as an attachment. Only `*.pinimg.com` URLs are allowed. |

Example:

```bash
curl "http://localhost:3000/api/resolve?url=https://www.pinterest.com/pin/104919866314746364/"
```

## How it works

For a given pin the backend tries, in order:

1. **Pinterest's `PinResource` JSON API** — the same endpoint Pinterest's own web app calls. Returns clean pin data including the `video_list` of MP4/HLS renditions.
2. **HTML state scrape** — parses the `__PWS_INITIAL_PROPS__` JSON embedded in the pin page (used when the API payload is unavailable).
3. **Raw URL scan** — last-resort regex scan of the page for `pinimg.com` MP4/M3U8 URLs.

Security notes: the server only accepts Pinterest page URLs for resolving and only `*.pinimg.com` hosts for downloads, which prevents it from being used as an open proxy. Requests are rate-limited (60/min per IP).

## Limitations

- Only **public** pins work. Private pins, private boards, and login-gated content are not accessible.
- Pins that embed an **external** video (e.g. a YouTube link) have no Pinterest-hosted file, so the app links to the source instead of downloading it.
- Pinterest changes its internals from time to time; the multi-strategy extractor is designed to survive this, but occasional breakage is possible.

## Disclaimer

This tool is intended for personal use with content you have the right to download. Respect creators' copyright and Pinterest's [Terms of Service](https://policy.pinterest.com/en/terms-of-service).

## License

MIT
