# Music Downloader

Local-first browser workspace for converting remote media into audio files, managing a persistent local track library, building simple mix projects, and finding similar music.

## Project Summary

This project turns a pasted media URL into downloadable audio files with a desktop-style browser workflow:

- workspace-based frontend with `Convert`, `Library`, `Mix`, and `Similar`
- source inspection, dense candidate selection, and queue monitoring
- persistent local library with uploads, playback, and bulk actions
- mix project creation, transition editing, and preview rendering
- backend batch job creation and polling
- `yt-dlp` download/extraction pipeline
- `ffmpeg` audio transcoding
- serial conversion queue
- download, preview, and similar-music suggestions

The current implementation is optimized for local development and single-user usage. Jobs are stored in memory, files are written to local disk, and conversions are processed with a small in-memory queue.

## Stack

- React + Vite frontend
- Express + TypeScript backend
- `yt-dlp` for media retrieval
- `ffmpeg` for audio extraction/transcoding

## Features

- `Convert` workspace with URL intake, source inspection, duration/size filters, and serial batch conversion
- right-side queue/progress inspector with downloads and similar-track lookup
- `Library` workspace with persistent local tracks, concise controls, download-first bulk actions, per-row downloads, search, sort, filter, and add-to-mix
- `Mix` workspace with mix projects, ordered sequence editing, explicit transition blocks, crossfade controls, and preview rendering/playback
- `Similar` workspace with seed-track selection and recommendation-to-convert flow
- output format selection (`mp3` or `m4a`)
- quality selection (`standard` or `high`)
- approximate conversion progress and item-level status
- clear dependency and failure reporting
- basic rate limiting on conversion requests
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
- React + Vite workspace-style app
- top-level workspaces: `Convert`, `Library`, `Mix`, `Similar`
- calls `/api/health`, `/api/sources/inspect`, `/api/jobs`, `/api/jobs/:id`, `/api/library`, `/api/mixes`, and `/api/recommendations`
- polls batch status every 2 seconds while conversions are active
- keeps dense list views and shared bulk action patterns across convert candidates, progress rows, library rows, and mix projects
- uses a restrained desktop-tool UI with concise copy and download-first library actions

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

### `POST /api/sources/inspect`

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

### `GET /api/library`

Returns locally stored library tracks from downloads, uploads, and imports.

### `POST /api/library/upload`

Uploads local audio files into the persistent library.

### `POST /api/library/import-existing`

Scans existing downloaded files and imports them into the library index.

### `DELETE /api/library`

Deletes selected library tracks.

### `GET /api/mixes`

Returns mix projects and their computed timelines.

### `POST /api/mixes`

Creates a new mix project.

### `POST /api/mixes/:id/tracks`

Adds a library track to the selected mix project.

### `PATCH /api/mixes/:id/tracks/:trackId`

Updates a mix track overlap/crossfade value.

### `DELETE /api/mixes/:id`

Deletes a mix project.

### `POST /api/mixes/:id/preview`

Renders an audio preview for the selected mix project.

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

4. Open the frontend at `http://127.0.0.1:5173`.

## Private Sharing

Recommended path for trusted users:

- run the built app locally
- expose it with Cloudflare Tunnel
- protect it with Cloudflare Access
- let users install it as a browser-based app icon

See [ACCESS.md](/Users/taljoseph/Documents/GitHub/Music%20Downloader/ACCESS.md) for the full setup guide and security model.

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
- local library browsing and playback
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
- Mix projects and library state are local-first and intended for single-machine use.
- Recommendation quality depends on provider coverage and metadata quality.
- Progress is derived from downloader output and is approximate.
- The frontend currently uses polling, not SSE or WebSockets.
- Large-scale abuse controls and auth are not implemented.
