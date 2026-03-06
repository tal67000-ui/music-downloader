# Security And Privacy Notes

## Scope

This project is a local-first media-to-audio converter intended for development and small-scale use.

## Current Protections

- backend binds to `127.0.0.1` by default
- proxy trust is disabled by default
- private and local network URLs are rejected
- `yt-dlp` config auto-loading is disabled
- `yt-dlp` call-home behavior is disabled
- raw backend error traces are sanitized before reaching the UI
- rate limiting exists on job creation

## Important Privacy Limitation

If this app runs on your laptop, the remote media source still sees the outbound IP/network path used by your laptop unless you route traffic differently.

This means:

- the app reduces local exposure
- the app does not provide anonymity by itself
- stronger privacy requires a separate outbound path such as `MEDIA_PROXY_URL`, a VPN, or another proxy strategy

## Operational Guidance

- keep `HOST=127.0.0.1` unless you intentionally want network exposure
- keep `TRUST_PROXY=false` unless the app is actually behind a trusted reverse proxy
- avoid loading personal cookies or site credentials into the downloader unless that is a deliberate decision
- update `yt-dlp` periodically because source-site behavior changes frequently
- do not commit machine-specific downloader binaries or private config into the repository

## Production Gaps

- no persistent database
- no auth or user isolation
- no durable audit logging
- no malware/content scanning on downloaded media
- no advanced abuse prevention
