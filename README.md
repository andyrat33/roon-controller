# roon-controller

A Roon extension that exposes a local REST API, enabling AI assistants (or any HTTP client) to search your library, control playback, and manage queues across all your zones.

Built to work with [Anthropic's Cowork](https://claude.ai) desktop tool — ask Claude to pick music for you and it just works.

---

## Architecture

```
AI Assistant / HTTP client (your Mac)
        │  HTTP → port 3001
        ▼
Docker container  (NAS / always-on server)
        │  Roon extension protocol (LAN)
        ▼
Roon Core
        │
        ▼
All your zones
```

---

## Prerequisites

- Roon running on your network
- Docker on an always-on machine (QNAP, Synology, Raspberry Pi, Linux server…)
- SSH access to that machine

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/andyrat33/roon-controller.git
cd roon-controller
```

### 2. Deploy

Copy to your NAS / server:

```bash
scp -r roon-controller admin@YOUR_NAS_IP:/share/Container/
ssh admin@YOUR_NAS_IP
cd /share/Container/roon-controller
docker compose up -d --build
```

> `network_mode: host` is required so Roon's SOOD discovery (UDP multicast) can find your Core on the LAN.

### 3. Authorise

Open Roon → **Settings → Extensions** → click **Enable** next to **Cowork Controller**.

### 4. Verify

```bash
curl http://YOUR_NAS_IP:3001/api/status | python3 -m json.tool
```

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status + now playing in all zones |
| GET | `/api/zones` | List all playback zones |
| GET | `/api/search?q=<query>[&type=tracks\|albums\|artists]` | Search library |
| GET | `/api/browse[?item_key=<key>]` | Browse library hierarchy |
| POST | `/api/find-and-play` | Search + play a single track `{ zone_id, query, action? }` |
| POST | `/api/play-album` | Play an entire album natively `{ zone_id, query, action? }` |
| POST | `/api/playlist` | Queue multiple tracks in order `{ name, zone_id, tracks[] }` |
| POST | `/api/play` | Play an item by key `{ zone_id, item_key, action? }` |
| POST | `/api/transport` | Playback control `{ zone_id, action }` |
| POST | `/api/volume` | Set volume `{ zone_id, how, value }` |
| POST | `/api/shuffle` | Enable/disable shuffle `{ zone_id, shuffle }` |
| GET | `/api/queue/:zone_id` | View queue |
| GET | `/api/inspect?q=<query>` | Debug: show Roon's exact action names |

### Transport actions
`play` · `pause` · `stop` · `next` · `previous` · `toggle_play_pause`

### Play actions
`Play Now` (default) · `Queue` · `Add Next` · `Start Radio`

### Album vs track playback

Use `/api/play-album` for albums — it navigates Roon's full browse hierarchy and queues all tracks natively in the correct order. The `/api/find-and-play` endpoint is for single tracks only. The `/api/playlist` endpoint queues tracks by individual search queries, useful for custom playlists but not for playing a specific album (tracks may match wrong versions).

---

## Python Helper

`roon_control.py` is a command-line wrapper for the API, useful for scripting or AI tool use.

Set your NAS IP:

```bash
export ROON_HOST=192.168.1.50
```

Examples:

```bash
python3 roon_control.py status
python3 roon_control.py zones
python3 roon_control.py search "Miles Davis" --type albums
python3 roon_control.py transport ZONE_ID next
python3 roon_control.py volume ZONE_ID 40 --how absolute
```

---

## Notes

- The RoonLabs API packages are not on npm — they're installed directly from [github.com/RoonLabs](https://github.com/RoonLabs). The Dockerfile installs `git` first for this reason.
- The extension uses `node-roon-api-browse` sessions internally; the REST API is stateless from the caller's perspective.
- Roon authorisation is persisted in a Docker volume (`roon_auth`) so you only need to authorise once.

---

## Related

- [Medium article: Controlling Roon with AI](https://medium.com/@andyrat33)
- [RoonLabs Node API](https://github.com/RoonLabs/node-roon-api)
- [Roon Community](https://community.roonlabs.com)

---

## Licence

MIT
