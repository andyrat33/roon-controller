# Controlling Roon with AI: How I Used Claude to Search My Library, Pick Music, and Build Playlists

*A step-by-step guide to building a Roon REST API extension that lets an AI assistant control your music — and a deep dive into what the Extension API can and can't do*

---

If you're a Roon user, you already know the library experience is exceptional. But what if your AI assistant could search that library, understand what you're in the mood for, and just play it — across any room in your house?

That's exactly what this guide covers. We'll build a small Roon extension that runs in Docker, exposes a local REST API, and lets Claude (via Anthropic's Cowork tool) control Roon on your behalf. By the end, you'll be able to say "play 10 songs from 1988 in the office" and have it actually work — complete with smart track selection based on your taste profile.

---

## What We're Building

A lightweight Node.js Roon extension that:

- Auto-discovers your Roon Core on the LAN
- Exposes a REST API for searching, browsing, and controlling playback
- Runs 24/7 in a Docker container (on a NAS, server, or always-on machine)
- Lets an AI assistant call that API to control your music
- Includes a Cowork skill so Claude knows your setup automatically in every session

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
├── extension.js          # The Roon extension + REST API server
├── package.json          # Dependencies (pulled from RoonLabs GitHub)
├── Dockerfile
├── docker-compose.yml
├── roon_control.py       # Python helper for calling the API
└── cowork-skill/
    ├── README.md         # Install guide for the Cowork skill
    └── roon/
        └── SKILL.md      # The skill file — edit with your zone IDs and IP
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

The `docker-compose.yml` also volume-mounts `extension.js` into the container, so you can update the extension and restart without a full rebuild:

```yaml
volumes:
  - roon_auth:/app/.roon
  - ./extension.js:/app/extension.js:ro
```

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

Auth persists across restarts — credentials are stored in the `roon_auth` Docker volume.

---

## Step 4: Test the API

From any machine on your network:

```bash
# What's playing right now?
curl http://YOUR_NAS_IP:3001/api/status | python3 -m json.tool

# List all zones with their IDs
curl http://YOUR_NAS_IP:3001/api/zones | python3 -m json.tool

# Search your library
curl "http://YOUR_NAS_IP:3001/api/search?q=Miles+Davis&type=Albums" | python3 -m json.tool
```

The status endpoint gives you a live view of every zone:

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
        "album": "Kind of Blue",
        "seek_position": 142,
        "length": 324
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
| GET | `/api/zones` | List all playback zones with IDs |
| GET | `/api/search?q=<query>[&type=Tracks\|Albums\|Artists]` | Search library + TIDAL |
| GET | `/api/browse[?item_key=<key>]` | Navigate the library hierarchy |
| POST | `/api/find-and-play` | **Main play endpoint** — search + play in one call |
| POST | `/api/playlist` | Queue multiple tracks in order |
| POST | `/api/transport` | Control playback `{ zone_id, action }` |
| POST | `/api/volume` | Set volume `{ zone_id, how, value }` |
| GET | `/api/queue/:zone_id` | View the current queue |
| GET | `/api/inspect?q=<query>` | Debug: show Roon's exact action names for a track |

### The find-and-play endpoint

This is the workhorse of the whole system. Give it a natural language query, a zone, and an action — it handles the full Roon browse session internally:

```bash
curl -X POST http://YOUR_NAS_IP:3001/api/find-and-play \
  -H "Content-Type: application/json" \
  -d '{
    "zone_id": "YOUR_ZONE_ID",
    "query": "Roxanne The Police",
    "type": "Tracks",
    "action": "Play Now"
  }'
```

```json
{ "success": true, "playing": "Roxanne — The Police, Sting", "action": "list" }
```

#### Roon's exact action labels

This is the thing that trips everyone up. Roon uses its own internal action strings, and wrong ones silently fall back to Play Now:

| What you want | Use this string |
|---------------|----------------|
| Play immediately (clears queue) | `Play Now` |
| Add to end of queue | `Queue` ← **NOT** "Add to Queue" |
| Play after current track | `Add Next` ← **NOT** "Play Next" |
| Start Roon Radio | `Start Radio` |

The `/api/inspect` endpoint was built specifically to debug this — it shows every action Roon offers at each navigation level for any track.

### Queuing playlists with /api/playlist

The `/api/playlist` endpoint lets you queue a list of tracks in one API call. First track plays immediately, the rest are appended to the queue in order:

```bash
curl -X POST http://YOUR_NAS_IP:3001/api/playlist \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My 1988 Mix",
    "zone_id": "YOUR_ZONE_ID",
    "tracks": [
      { "query": "Domino Dancing Pet Shop Boys" },
      { "query": "Behind The Wheel Depeche Mode" },
      { "query": "Desire U2" },
      { "query": "Fast Car Tracy Chapman" }
    ]
  }'
```

```json
{
  "name": "My 1988 Mix",
  "note": "Tracks queued successfully. To save as a Roon playlist: Queue → ⋮ → Save Queue as Playlist.",
  "queued": 4,
  "total": 4
}
```

#### A word on "Add to Playlist"

One thing I discovered the hard way: **Roon's Extension API does not expose playlist management to third-party extensions**. No "Add to Playlist", no "Create Playlist" — only playback actions (Play Now, Add Next, Queue, Start Radio) are available regardless of which browse hierarchy you navigate.

This isn't a bug in the extension — it's a deliberate limitation of the Extension API. The workaround is the queue-then-save pattern: queue your tracks via the API, then in the Roon app go **Queue → ⋮ → Save Queue as Playlist** to give it a permanent name. One tap.

### Transport and volume

```bash
# Skip to next track
curl -X POST http://YOUR_NAS_IP:3001/api/transport \
  -H "Content-Type: application/json" \
  -d '{ "zone_id": "YOUR_ZONE_ID", "action": "next" }'

# Set volume to 35
curl -X POST http://YOUR_NAS_IP:3001/api/volume \
  -H "Content-Type: application/json" \
  -d '{ "zone_id": "YOUR_ZONE_ID", "how": "absolute", "value": 35 }'
```

Transport actions: `play`, `pause`, `stop`, `next`, `previous`, `toggle_play_pause`

Volume `how`: `absolute`, `relative`, `relative_step`

---

## Step 5: Connect AI

### Option A — Python helper

The included `roon_control.py` is a command-line helper. Edit the IP at the top:

```python
QNAP_IP = '192.168.1.50'   # your NAS IP
```

```bash
python3 roon_control.py status
python3 roon_control.py search "Nils Frahm"
python3 roon_control.py transport ZONE_ID next
```

### Option B — Claude Cowork skill (recommended)

The repo includes a Cowork skill that teaches Claude your entire setup — zone IDs, API patterns, Roon's action strings, your library and taste profile — so it works correctly from the first message in every new session.

Install it by copying `cowork-skill/roon/` to your Cowork skills directory (see `cowork-skill/README.md` for the exact path), then edit `SKILL.md` with your NAS IP, zone IDs, and library details.

Once installed you can just say:

- *"Play 10 songs from 1988 in the office"*
- *"Queue up 3 Dire Straits classics"*
- *"What's playing in the kitchen?"*
- *"Turn the volume up to 40 in the living room"*
- *"Put something relaxing on"*

Claude will search your library and TIDAL, pick tracks that match your taste profile, handle all the API calls, and report back what it's playing.

> **Important for Cowork users:** Python can't reach the NAS from inside Cowork's sandbox ("No route to host"). Always use `curl` via `osascript`. The skill handles this automatically, but if you're building your own integration this is the key pattern:
>
> ```applescript
> do shell script "echo " & quoted form of payload & " > /tmp/rp.json && curl -s -X POST http://NAS_IP:3001/api/find-and-play -H 'Content-Type: application/json' -d @/tmp/rp.json"
> ```
>
> The `/tmp/rp.json` trick sidesteps AppleScript quoting failures on track titles containing apostrophes (Don't Stand So Close To Me, I Don't Want Your Love, etc.).

---

## How It Works Under the Hood

Roon has a well-designed extension API (huge credit to [RoonLabs](https://github.com/RoonLabs) for keeping it open). The key packages are:

- `node-roon-api` — core connection and discovery
- `node-roon-api-browse` — hierarchical library browsing and search
- `node-roon-api-transport` — playback control and zone management

Discovery uses SOOD (Simple One-way Discovery Protocol) over UDP multicast — which is why `network_mode: host` is non-negotiable in Docker. Once paired, the extension maintains a persistent WebSocket-style connection to the Core.

### The browse API session model

This is the subtlest part. The browse API is session-stateful: every `browse()` call creates or continues a server-side session identified by a `multi_session_key`, and `load()` fetches results from that same session. Item keys from one session are invalid in another.

The `find-and-play` endpoint navigates a full search → category → track → action chain all within a single session — this is why it works reliably when naive two-step approaches fail:

```javascript
// All steps use the same msKey throughout
_browse.browse({ hierarchy: 'search', input: query, multi_session_key: msKey }, () => {
  _browse.load({ ..., multi_session_key: msKey }, (err, topR) => {
    // navigate to Tracks category using item_key from topR
    // navigate to first track using item_key from category
    // navigate to action using item_key from track
    // execute "Play Now" / "Queue" / etc.
  });
});
```

The search endpoint solves a different problem: loading multiple categories (Tracks, Albums, Artists) in parallel. Each category needs its own fresh session because navigating one category invalidates the item keys of siblings:

```javascript
// Each category gets its own independent session
categories.forEach(cat => {
  const catKey = `search-${cat.title}-${Date.now()}`;
  _browse.browse({ hierarchy: 'search', input: q, multi_session_key: catKey }, ...);
});
```

---

## Possible Extensions

A few ideas for taking this further:

- **Now Playing webhook**: Use `subscribe_zones` to push zone state changes to Home Assistant, a dashboard, or any webhook endpoint
- **Mood-based radio**: Feed the AI your listening history and let it construct a queue based on mood or energy level
- **Multi-room sync**: Use the transport API's grouping support to sync zones together on demand
- **Voice control**: Wrap the API with a HomeKit/Shortcuts integration for Siri control

---

## Resources

- **Source code**: [github.com/andyrat33/roon-controller](https://github.com/andyrat33/roon-controller)
- **RoonLabs API repos**: [github.com/RoonLabs](https://github.com/RoonLabs)
- **Roon Extension documentation**: [roonlabs.github.io/node-roon-api](https://roonlabs.github.io/node-roon-api)
- **Roon Community**: [community.roonlabs.com](https://community.roonlabs.com)

---

*Built and tested with Roon Core on QNAP, Docker on QNAP Container Station, and Claude via Anthropic's Cowork desktop tool.*
