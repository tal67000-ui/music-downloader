# AGENTS.md

## Project

Music Downloader is a local-first web app that converts remote media into downloadable audio files and suggests similar music from completed tracks.

Core flow:

1. User submits a source URL.
2. Frontend inspects the source and lets the user select candidate videos.
3. Backend creates a serial batch job.
4. Backend uses `yt-dlp` and `ffmpeg` to extract/transcode audio one item at a time.
5. Frontend polls job status until completion.
6. User previews/downloads results and can request similar tracks.

## Repo Layout

- `client/`: React + Vite frontend
- `server/`: Express + TypeScript backend
- `output/`: generated audio files
- `tmp/`: temporary files
- `bin/`: local downloader binaries

## Important Files

- `server/src/app.ts`
  Main API wiring for source inspection, batch creation, polling, and recommendations.
- `server/src/jobStore.ts`
  In-memory batch job store, queueing, conversion execution, cleanup.
- `server/src/recommendations.ts`
  Similar-music lookup and ranking using MusicBrainz and Last.fm.
- `server/src/progress.ts`
  Maps `yt-dlp` stderr into app progress states.
- `server/src/validation.ts`
  Input validation and private/local network blocking.
- `client/src/App.tsx`
  Main workspace UI for Convert, Library, Mix, and Similar.
- `.env`
  Runtime configuration, especially `YT_DLP_PATH`, `FFMPEG_PATH`, `LASTFM_API_KEY`, and `MUSICBRAINZ_CONTACT`.

## Runtime Assumptions

- Jobs are stored in memory.
- Recommendation cache is stored in memory.
- Rate limits are stored in memory.
- Output files are written to local disk.
- Job status is fetched by polling, not SSE/WebSockets.
- This repo is currently optimized for local development and manual testing.

## Environment Notes

Use explicit binary paths when available.

Current working local setup:

- `YT_DLP_PATH=/absolute/path/to/bin/yt-dlp_macos`
- `FFMPEG_PATH=/Users/taljoseph/Library/Python/3.9/lib/python/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1`
- `LASTFM_API_KEY=...`
- `MUSICBRAINZ_CONTACT=you@example.com`

Important:

- Prefer the standalone `yt-dlp_macos` binary over the Python-installed `yt-dlp` script in this environment.
- The Python path was unreliable because the machine Python is 3.9, while modern `yt-dlp` Python releases require 3.10+.
- This app does not make the host machine anonymous by itself. If the user wants the remote source not to see laptop-originated traffic, use `MEDIA_PROXY_URL` or an external VPN/proxy path.
- Do not commit machine-specific binaries in `bin/`.

## Working Rules

- Keep output and temp directories resolved from project root.
- Prefer updating existing backend flow in `server/src/app.ts` and `server/src/jobStore.ts` instead of introducing parallel job systems.
- Preserve explicit binary-path support.
- If you change downloader behavior, test at least:
  - a direct audio URL
  - a YouTube URL
- Be careful with YouTube-specific flags. Upstream `yt-dlp` behavior changes over time.

## Validation

Before finishing meaningful changes, run:

```bash
npm --workspace server run test
npm run build
```

For UI or conversion changes, also test the live app manually when possible:

```bash
npm run dev
```

## Current Features

- workspace tabs for `Convert`, `Library`, `Mix`, and `Similar`
- URL submission
- source inspection for multi-video pages
- check/uncheck batch selection
- duration/size filtering before conversion
- serial conversion queue
- `mp3` and `m4a` output
- `standard` and `high` quality presets
- job polling
- approximate progress updates
- preview and download UI
- persistent local track library
- local uploads
- download-first library toolbar and compact download rail
- bulk download/delete
- per-row download action
- playback controls
- mix project creation/deletion
- add to mix
- crossfade editing
- preview render
- preview playback
- similar-music suggestions for completed tracks
- downloader-ready recommendation resolution for one-click follow-up conversions
- in-memory rate limiting
- private/local URL blocking
- working YouTube conversion via standalone `yt-dlp` binary

## Known Limits

- no persistent database
- no auth
- no distributed workers
- no durable retries
- no real-time push updates
- not production-scaled
- recommendation quality depends on external metadata provider coverage

## Good Next Steps

- replace polling with SSE
- add persistent job storage
- add queue-from-recommendation flow
- add structured backend logging for subprocess failures
- improve frontend messaging for extractor/site-specific failures
- add end-to-end browser automation
