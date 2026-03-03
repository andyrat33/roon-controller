# Controlling Roon with AI: How I Used Claude to Search My Library, Pick Music, and Manage Playback

*A step-by-step guide to building a Roon REST API extension that lets an AI assistant control your music*

---

If you're a Roon user, you already know the library experience is exceptional. But what if your AI assistant could search that library, understand what you're in the mood for, and just play it — across any room in your house?

That's exactly what this guide covers. We'll build a small Roon extension that runs in Docker, exposes a local REST API, and lets Claude (via Anthropic's Cowork tool) control Roon on your behalf. By the end, you'll be able to say "play something like Miles Davis but more relaxed" and have it actually work.

---

## What We're Building

A lightweight Node.js Roon extension that:

- Auto-discovers your Roon Core on the LAN
- Exposes a REST API for searching, browsing, and controlling playback
- Runs 24/7 in a Docker container (on a NAS, server, or always-on machine)
- Lets an AI assistant call that API to control your music

```
AI Assistant (Claude/Cowork on your Mac)
        │  HTTP calls → port 3001
        ▼
Docker container (QNAP NAS / always-on machine)
        │  Roon extension protocol
        ▼
Roon Core
        │
        ▼
All your zones (living room, office, kitchen…)
```

---

## Prerequisites

- **Roon** running on your network (Core on any platform)
- **Docker** on an always-on machine — a NAS (QNAP, Synology) works perfectly
- Basic comfort with a terminal and SSH
- The full source code: [github.com/andyrat33/roon-controller](https://github.com/andyrat33/roon-controller)

---

## Step 1: Get the Code

```bash
git clone https://github.com/andyrat33/roon-controller.git
cd roon-controller
```

The project contains:

```
roon-controller/
├── extension.js       # The Roon extension + REST API server
├── package.json       # Dependencies (pulled from RoonLabs GitHub)
├── Dockerfile
├── docker-compose.yml
└── roon_control.py    # Python helper for calling the API
```

---

## Step 2: Deploy on Your NAS / Server

Copy the folder to your NAS:

```bash
scp -r roon-controller admin@YOUR_NAS_IP:/share/Container/
```

SSH in and build:

```bash
ssh admin@YOUR_NAS_IP
cd /share/Container/roon-controller
docker compose up -d --build
```

> **Note:** The Roon API packages aren't on npm — they're hosted on GitHub by RoonLabs. The Dockerfile installs `git` first so npm can clone them directly. The `docker-compose.yml` uses `network_mode: host`, which is essential for Roon's SOOD discovery protocol (UDP multicast) to find your Core.

You should see in the logs:

```
🎵 Cowork Roon Controller
   REST API → http://0.0.0.0:3001
🔍 Searching for Roon Core on the network...
```

---

## Step 3: Authorise in Roon

Open Roon, go to **Settings → Extensions**, and you'll see **Cowork Controller** waiting for authorisation. Click **Enable**.

The logs will immediately show:

```
✅ Paired with Roon Core: [your core name]
```

---

## Step 4: Test the API

From any machine on your network:

```bash
# What's playing right now?
curl http://YOUR_NAS_IP:3001/api/status | python3 -m json.tool

# List all zones
curl http://YOUR_NAS_IP:3001/api/zones | python3 -m json.tool

# Search your library
curl "http://YOUR_NAS_IP:3001/api/search?q=Miles+Davis&type=albums" | python3 -m json.tool
```

The status endpoint gives you a live view of every zone — what's playing, current state, volume:

```json
{
  "connected": true,
  "core_name": "QNAP",
  "zones": [
    {
      "display_name": "Living Room",
      "state": "playing",
      "now_playing": {
        "title": "Kind of Blue",
        "artist": "Miles Davis",
        "album": "Kind of Blue"
      }
    }
  ]
}
```

---

## The REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status + now playing across all zones |
| GET | `/api/zones` | List all playback zones |
| GET | `/api/search?q=<query>[&type=tracks\|albums\|artists]` | Search your library |
| GET | `/api/browse[?item_key=<key>]` | Navigate the library hierarchy |
| POST | `/api/play` | Play an item `{ zone_id, item_key, action? }` |
| POST | `/api/transport` | Control playback `{ zone_id, action }` |
| POST | `/api/volume` | Set volume `{ zone_id, how, value }` |
| GET | `/api/queue/:zone_id` | View the current queue |

### Playing something

Search returns `item_key` values for every result. Pass one to `/api/play` with your target zone:

```bash
# 1. Search
curl "http://YOUR_NAS_IP:3001/api/search?q=Kind+of+Blue&type=albums"
# → returns item_key for the album

# 2. Play it
curl -X POST http://YOUR_NAS_IP:3001/api/play \
  -H "Content-Type: application/json" \
  -d '{ "zone_id": "YOUR_ZONE_ID", "item_key": "ITEM_KEY_FROM_SEARCH" }'
```

The `/api/play` endpoint handles the full Roon browse action flow internally — it navigates to the item, finds the "Play Now" action, and executes it. You can also pass `"action": "Add to Queue"` or `"action": "Play Next"` if you prefer.

### Transport controls

```bash
curl -X POST http://YOUR_NAS_IP:3001/api/transport \
  -H "Content-Type: application/json" \
  -d '{ "zone_id": "YOUR_ZONE_ID", "action": "next" }'
```

Valid actions: `play`, `pause`, `stop`, `next`, `previous`, `toggle_play_pause`

---

## Step 5: Let AI Control It

The included `roon_control.py` is a command-line helper that an AI assistant (or you) can call directly. Edit the IP at the top:

```python
QNAP_IP = '192.168.1.50'   # your NAS IP
```

Or set it as an environment variable:

```bash
export ROON_HOST=192.168.1.50
```

Then from the terminal:

```bash
python3 roon_control.py status
python3 roon_control.py search "Nils Frahm"
python3 roon_control.py transport ZONE_ID next
```

If you're using Claude via Anthropic's Cowork tool, it can call these commands autonomously — searching your library, picking tracks based on your mood, queuing albums, and adjusting volume across zones, all through natural conversation.

---

## How It Works Under the Hood

Roon has a well-designed extension API (huge credit to [RoonLabs](https://github.com/RoonLabs) for keeping it open). The key packages are:

- `node-roon-api` — core connection and discovery
- `node-roon-api-browse` — hierarchical library browsing and search
- `node-roon-api-transport` — playback control and zone management

Discovery uses SOOD (Simple One-way Discovery Protocol) over UDP multicast — which is why `network_mode: host` is non-negotiable in Docker. Once paired, the extension maintains a persistent WebSocket-style connection to the Core.

The browse API is session-based. Each search or navigation call creates a server-side session (identified by a `multi_session_key`), and results are loaded in a separate call. Our REST wrapper handles this statefulness internally so callers just get clean JSON back.

---

## Possible Extensions

A few ideas for taking this further:

- **Playlist creation**: Roon's browse API exposes playlist management — you could expose a `POST /api/playlist` endpoint to create and populate playlists
- **Now Playing webhook**: Use `subscribe_zones` to push zone state changes to a webhook endpoint (Home Assistant, for example)
- **Mood-based radio**: Feed the AI your listening history and let it construct a queue based on mood or energy level
- **Multi-room sync**: Use the transport API's grouping support to sync zones together

---

## Resources

- **Source code**: [github.com/andyrat33/roon-controller](https://github.com/andyrat33/roon-controller)
- **RoonLabs API repos**: [github.com/RoonLabs](https://github.com/RoonLabs)
- **Roon Extension documentation**: [roonlabs.github.io/node-roon-api](https://roonlabs.github.io/node-roon-api)
- **Roon Community**: [community.roonlabs.com](https://community.roonlabs.com)

---

*Built and tested with Roon Core on QNAP, Docker on QNAP Container Station, and Claude via Anthropic's Cowork desktop tool.*
