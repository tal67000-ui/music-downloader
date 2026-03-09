# Private Access Plan

This app is best shared as a private, on-demand service.

Recommended architecture:

1. Run the app on a machine you control.
2. Keep the app bound to `127.0.0.1`.
3. Expose it through Cloudflare Tunnel.
4. Protect it with Cloudflare Access and an allowlist of known email addresses.
5. Have users install it from the browser as a web app icon if they want a desktop-style shortcut into the workspace UI.

## Why this is the recommended setup

- Cloudflare Tunnel uses outbound-only connections and avoids exposing a public IP or inbound port.
- Cloudflare documents Tunnel as `No open inbound ports. No public IPs. No attack surface.`
- Cloudflare Access adds an authentication gate in front of the app for known users.
- Cloudflare's Access product page currently lists a free plan for teams under 50 users.

Sources:

- [Cloudflare Tunnel docs](https://developers.cloudflare.com/tunnel/)
- [Cloudflare Tunnel connection model](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Cloudflare Access self-hosted app guide](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/)
- [Cloudflare Access pricing](https://www.cloudflare.com/sase/products/access/)

## Security model

What this setup protects:

- no inbound port forwarding on your router
- no direct exposure of your backend to the internet
- app protected by Cloudflare login before traffic reaches the tunnel
- easy allowlist of only people you know

What it does not hide:

- media source sites still see the outbound IP of the machine running `yt-dlp`
- if the app runs on your laptop, downloads still originate from your laptop's network path

If you need stronger privacy later, move the app to a separate box or route outbound media traffic via `MEDIA_PROXY_URL`.

## Recommended user count

This is a good fit for:

- you
- a few friends or family members
- lightweight private sharing

This is not the right fit for:

- public anonymous users
- large shared communities
- always-on high-volume use

## Owner Setup

### 1. Prepare the app

From the repo root:

```bash
npm install
cp .env.example .env
npm run share:up
```

The production app serves the built frontend and backend together from `http://127.0.0.1:8786`.

To stop it later:

```bash
npm run share:down
```

### 2. Install Cloudflare Tunnel

Install `cloudflared` on the machine running the app.

Official docs:

- [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### 3. Create a tunnel

Use Cloudflare's dashboard or CLI to create a tunnel and map a hostname such as:

- `music.yourdomain.com`

Use the example config in [deploy/cloudflared-config.yml.example](/Users/taljoseph/Documents/GitHub/Music%20Downloader/deploy/cloudflared-config.yml.example).

### 4. Protect it with Cloudflare Access

In Cloudflare Zero Trust:

1. Create a self-hosted application for `music.yourdomain.com`
2. Add an allow policy
3. Restrict access to the email addresses of people you know
4. Set a reasonable session duration such as 24 hours or 7 days
5. In the tunnel settings, enable the equivalent of `Protect with Access` so the origin only accepts requests that passed Access

Recommended identity method:

- email one-time PIN for the simplest setup

If all users already use the same provider, Google login is cleaner.

### 5. Share the app

Send trusted users:

- the URL
- a short note that they must sign in through Cloudflare Access
- optional install instructions below

## User Experience

### Browser access

Users just open the protected URL and sign in.

Once inside, they land in the browser workspace with separate `Convert`, `Library`, `Mix`, and `Similar` tabs. That structure works well for trusted, repeat users because local library and mix workflows are more discoverable than a single long page.

### Install as an app icon

This repo now includes a web app manifest and service worker so supported browsers can install it as a standalone app.

Desktop options:

- Chrome or Edge: use `Install app`
- Safari on macOS: use `Add to Dock`

Mobile options:

- iPhone/iPad Safari: `Share` -> `Add to Home Screen`
- Android Chrome: `Add to Home screen` or `Install app`

That gives them an app-like icon without needing an App Store or Electron build.

## Operating Model

Best low-cost workflow:

1. Start the app only when you want to use/share it
2. Start `cloudflared`
3. Stop both when done

This keeps your exposure and maintenance low.

## Optional Mac convenience

If you want the app to be easier to start on your Mac, use the example launch agent in [deploy/music-downloader.launchd.plist.example](/Users/taljoseph/Documents/GitHub/Music%20Downloader/deploy/music-downloader.launchd.plist.example) as a template.

## What not to use

- Do not expose your router with manual port forwarding.
- Do not leave the app open on `0.0.0.0` without an access layer.
- Do not rely on quick tunnels for regular sharing. Cloudflare documents quick tunnels as testing-only and notes a `200 concurrent request` limit.

## Optional Next Step

If you want this to be available even when your laptop is asleep or offline, move the app to:

- a Mac mini
- a home server
- a small always-on machine you control

That is the cleanest upgrade path while keeping the same Cloudflare Tunnel + Access model.
