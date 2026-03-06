# Music Downloader

Web app that accepts a media URL, extracts the best available audio, and returns a downloadable audio file for listening.

## Project Summary

This project turns a pasted media URL into downloadable audio files with a fast browser flow:

- frontend form for source inspection, selection, and quality selection
- backend batch job creation and polling
- `yt-dlp` download/extraction pipeline
- `ffmpeg` audio transcoding
- serial conversion queue
- output preview, download, and similar-music suggestions

The current implementation is optimized for local development and single-user usage. Jobs are stored in memory, files are written to local disk, and conversions are processed with a small in-memory queue.

## Stack

- React + Vite frontend
- Express + TypeScript backend
- `yt-dlp` for media retrieval
- `ffmpeg` for audio extraction/transcoding

## Features

- Submit a video or audio URL
- Inspect a source page that contains many videos
- Check or uncheck which tracks should be converted
- Convert selected tracks one by one in a serial queue
- Show completed, active, queued, and failed items inside the batch
- Estimate full batch duration from reported media durations
- Choose output format (`mp3` or `m4a`)
- Choose target quality (`standard` or `high`)
- Track conversion progress
- Preview and download the converted audio
- Ask for similar music based on a completed track
- Open a recommendation in source search or resolve it directly into a new download
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
- calls `/api/health`, `/api/source`, `/api/jobs`, `/api/jobs/:id`, and `/api/recommendations`
- polls batch status every 2 seconds while conversions are active
- shows dependency readiness, source inspection results, serial queue state, recommendation results, and rate-limit feedback

### Backend

- location: `server/`
- Express API with TypeScript
- validates input with `zod`
- stores jobs and recommendation cache in memory
- enforces a small in-memory concurrency cap
- cleans up expired output files on an interval

### Media pipeline

- source inspection via `yt-dlp --flat-playlist`
- title probing and media extraction using `yt-dlp`
- audio conversion through `ffmpeg`
- output files written to `output/`
- temporary files written to `tmp/`

### Recommendation pipeline

- seed track is inferred from the completed item title
- MusicBrainz is used to canonicalize title and artist when possible
- Last.fm is used for similar-track and similar-artist recommendations when `LASTFM_API_KEY` is configured
- MusicBrainz-only fallback recommendations are returned when Last.fm is not configured

## API Summary

### `GET /api/health`

Returns dependency readiness and server settings relevant to the frontend.

### `POST /api/source`

Inspects a source URL and returns a flat list of candidate videos/tracks that can be selected for conversion.

### `POST /api/jobs`

Creates a serial conversion batch from:

- `url`
- `entries`
- `format`: `mp3` or `m4a`
- `quality`: `standard` or `high`

Returns `202` with the created job, or:

- `400` for invalid input
- `429` when rate limited
- `503` when required binaries are missing

### `GET /api/jobs/:id`

Returns the latest state of a batch job and all item-level statuses.

### `POST /api/recommendations`

Accepts:

- `title`
- optional `artist`
- optional `sourceUrl`

Returns the canonicalized seed track, provider status, and a ranked list of similar tracks.

### `POST /api/recommendations/resolve`

Accepts a recommendation search query and resolves it to a concrete downloadable media source, which the frontend can send straight into the converter.

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
   `LASTFM_API_KEY` is optional but recommended for better similar-music suggestions.
   `MUSICBRAINZ_CONTACT` is optional but recommended so MusicBrainz requests include an identifiable contact string.

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
- recommendation endpoint behavior

Browser verification has also been done manually against the local app, including:

- direct MP3 conversion
- serial conversion from a multi-video YouTube page
- similar-music lookup on a completed download
- rate-limit UX

## Operational Notes

- Output quality is capped by the source media quality.
- Jobs are not persisted across server restarts.
- Rate limiting is in-memory and resets on server restart.
- Cleanup is local-disk based and intended for development/small-scale use.
- Recommendation caching is in-memory and resets on server restart.
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
- Recommendation quality depends on provider coverage and metadata quality.
- Progress is derived from downloader output and is approximate.
- The frontend currently uses polling, not SSE or WebSockets.
- Large-scale abuse controls and auth are not implemented.
