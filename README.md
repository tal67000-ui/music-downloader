# Music Downloader

Web app that accepts a media URL, extracts the best available audio, and returns a downloadable audio file for listening.

## Project Summary

This project turns a pasted media URL into a downloadable audio file with a fast browser flow:

- frontend form for URL, format, and quality selection
- backend job creation and polling
- `yt-dlp` download/extraction pipeline
- `ffmpeg` audio transcoding
- output preview and download

The current implementation is optimized for local development and single-user usage. Jobs are stored in memory, files are written to local disk, and conversions are processed with a small in-memory queue.

## Stack

- React + Vite frontend
- Express + TypeScript backend
- `yt-dlp` for media retrieval
- `ffmpeg` for audio extraction/transcoding

## Features

- Submit a video or audio URL
- Choose output format (`mp3` or `m4a`)
- Choose target quality (`standard` or `high`)
- Track conversion progress
- Preview and download the converted audio
- Clear dependency and failure reporting
- Basic rate limiting on conversion requests
- YouTube support via the official standalone `yt-dlp` macOS binary

## Requirements

The backend shells out to two required binaries:

- `ffmpeg`
- `yt-dlp`

They must either be installed on `PATH` or configured explicitly in `.env`.

If they are installed in user-local locations, set `YT_DLP_PATH` and `FFMPEG_PATH` in `.env`.

Current local setup in this repo uses:

- `FFMPEG_PATH` pointing at the packaged `imageio-ffmpeg` binary
- `YT_DLP_PATH` pointing at a local standalone `yt-dlp` binary such as `bin/yt-dlp_macos`

The standalone `yt-dlp_macos` binary is important because newer `yt-dlp` releases no longer support Python 3.9, and the system Python in this environment is 3.9.

Note:

- local binaries under `bin/` are runtime dependencies and should not be committed
- each machine should install or download its own `yt-dlp` binary and set `YT_DLP_PATH` accordingly

## Architecture

### Frontend

- location: `client/`
- React + Vite single-page app
- calls `/api/health`, `/api/jobs`, and `/api/jobs/:id`
- polls job status every 2 seconds while a conversion is active
- shows dependency readiness, progress, download state, and rate-limit feedback

### Backend

- location: `server/`
- Express API with TypeScript
- validates input with `zod`
- stores jobs in memory
- enforces a small in-memory concurrency cap
- cleans up expired output files on an interval

### Media pipeline

- title probing via `yt-dlp --print`
- download/extract using `yt-dlp`
- audio conversion through `ffmpeg`
- output files written to `output/`
- temporary files written to `tmp/`

## API Summary

### `GET /api/health`

Returns dependency readiness and server settings relevant to the frontend.

### `POST /api/jobs`

Creates a conversion job from:

- `url`
- `format`: `mp3` or `m4a`
- `quality`: `standard` or `high`

Returns `202` with the created job, or:

- `400` for invalid input
- `429` when rate limited
- `503` when required binaries are missing

### `GET /api/jobs/:id`

Returns the latest state of a conversion job.

### `GET /downloads/:filename`

Serves a completed output file.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

   If you installed binaries into user-local locations, update `YT_DLP_PATH` and `FFMPEG_PATH` in `.env` to match your machine.

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open the frontend at `http://localhost:5173`.

## Useful Commands

```bash
npm run dev
npm run build
npm --workspace server run test
```

## Testing

Backend tests currently cover:

- progress parsing
- valid job creation
- private-network URL rejection
- rate limiting

Browser verification has also been done manually against the local app, including:

- direct MP3 conversion
- YouTube conversion
- rate-limit UX

## Operational Notes

- Output quality is capped by the source media quality.
- Jobs are not persisted across server restarts.
- Rate limiting is in-memory and resets on server restart.
- Cleanup is local-disk based and intended for development/small-scale use.
- YouTube behavior can change over time, so `yt-dlp` may need periodic updates.

## Privacy And Safety

- The backend now binds to `127.0.0.1` by default, so it is not exposed to your local network unless you change `HOST`.
- The app does not open the submitted media URL in your browser; downloads happen server-side through `yt-dlp`.
- The backend disables `yt-dlp` config auto-loading with `--no-config-locations`, which reduces accidental use of local cookies or user-specific downloader settings.
- Error messages returned to the UI are sanitized so local filesystem paths are not exposed.

Important limitation:

- If the app runs directly on your laptop, the remote source still sees the outbound network IP used by your laptop.
- That means this app alone cannot guarantee that a media site cannot correlate requests back to your machine or network.
- If you need stronger privacy, set `MEDIA_PROXY_URL` to a trusted proxy endpoint or run the app behind a VPN/Tor-capable network path.

## Limitations

- This is not yet production hardened for multi-user deployment.
- There is no persistent job database.
- Progress is derived from downloader output and is approximate.
- The frontend currently uses polling, not SSE or WebSockets.
- Large-scale abuse controls and auth are not implemented.
