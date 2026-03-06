# Music Downloader Project Brief

## What This Repo Is

This is a local-first web app that converts a remote media URL into an audio download.

Primary user flow:

1. User pastes a video or audio URL.
2. User chooses `mp3` or `m4a` and a quality preset.
3. Backend creates a job and runs `yt-dlp` + `ffmpeg`.
4. Frontend polls the job until completion.
5. User previews and downloads the finished audio file.

## Tech Stack

- root workspace with `client` and `server`
- frontend: React + Vite + TypeScript
- backend: Express + TypeScript
- validation: `zod`
- tests: `vitest`
- downloader: `yt-dlp`
- transcoder: `ffmpeg`

## Important Directories

- `client/`: browser app
- `server/src/`: API, job handling, media pipeline
- `output/`: generated audio files
- `tmp/`: temporary files
- `bin/`: local downloader binaries

## Current Runtime Model

- job state is stored in memory
- request rate limiting is stored in memory
- conversion concurrency is capped by `MAX_CONCURRENT_JOBS`
- output cleanup is time-based
- files are served directly from `/downloads`

This means restarts clear active job state and rate-limit buckets.

## Important Files

- `server/src/app.ts`
  API wiring and testable job creation handler.
- `server/src/jobStore.ts`
  In-memory jobs, queueing, conversion execution, cleanup.
- `server/src/progress.ts`
  Parses `yt-dlp` stderr into user-facing progress updates.
- `server/src/validation.ts`
  Request validation and private/local network URL blocking.
- `client/src/App.tsx`
  Main UI, polling flow, error handling, rate-limit UX.
- `.env`
  Local runtime configuration, including binary paths.

## Environment Notes

This repo currently depends on explicit binary paths.

Expected local configuration:

- `YT_DLP_PATH=/absolute/path/to/bin/yt-dlp_macos`
- `FFMPEG_PATH=/Users/taljoseph/Library/Python/3.9/lib/python/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1`

Reason:

- the Python-installed `yt-dlp` path was not reliable here because the environment uses Python 3.9
- modern `yt-dlp` releases require Python 3.10+ if using the Python distribution
- the standalone macOS binary avoids that dependency problem
- local binaries under `bin/` are environment-specific and should not be committed to the repo

Privacy note:

- This app runs media fetches from the machine hosting the backend.
- Without a proxy/VPN, remote media sources can still see that machine's outbound IP.
- The app reduces local exposure, but it does not create anonymity by itself.
- `MEDIA_PROXY_URL` exists for routing downloader traffic through a separate outbound path when needed.

## Commands

Run everything:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Backend tests:

```bash
npm --workspace server run test
```

## Current Features

- URL submission for media conversion
- `mp3` and `m4a` output
- `standard` and `high` quality presets
- job polling
- approximate live progress parsing
- preview/download UI
- in-memory rate limiting
- local/private network URL rejection
- YouTube support using the standalone `yt-dlp` binary

## Known Constraints

- no persistent database
- no auth
- no SSE/WebSocket progress streaming
- no distributed queue
- no durable retries
- not production-scaled

## If You Modify This Repo

- keep output and temp paths resolved from project root
- prefer updating `server/src/app.ts` and `server/src/jobStore.ts` instead of adding parallel job logic
- preserve explicit binary path support in config
- be careful with YouTube changes; test a real URL after touching downloader args
- run:

```bash
npm --workspace server run test
npm run build
```

## Suggested Next Improvements

- replace polling with SSE
- add persistent job storage
- add structured logging around subprocess failures
- improve frontend messaging for site-specific extractor failures
- add end-to-end browser automation for the happy path
