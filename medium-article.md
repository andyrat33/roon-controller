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

**Playback:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status + now playing across all zones |
| GET | `/api/zones` | List all playback zones with IDs |
| GET | `/api/search?q=<query>[&type=Tracks\|Albums\|Artists]` | Search library + TIDAL |
| GET | `/api/browse[?item_key=<key>]` | Navigate the library hierarchy |
| POST | `/api/find-and-play` | Search + play a single track |
| POST | `/api/play-album` | **Play an entire album** — natively queues all tracks in order |
| POST | `/api/playlist` | Queue multiple tracks in order |
| POST | `/api/transport` | Control playback `{ zone_id, action }` |
| POST | `/api/volume` | Set volume `{ zone_id, how, value }` |
| POST | `/api/shuffle` | Enable/disable shuffle `{ zone_id, shuffle }` |
| GET | `/api/queue/:zone_id` | View the current queue |
| GET | `/api/inspect?q=<query>` | Debug: show Roon's exact action names for a track |

**Multi-room & zone control:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/mute` | Mute or unmute a zone `{ zone_id, mute }` |
| POST | `/api/mute/all` | Mute or unmute every zone `{ mute }` |
| POST | `/api/pause/all` | Pause all zones simultaneously |
| POST | `/api/standby` | Toggle standby on a zone's output `{ zone_id }` |
| POST | `/api/group` | Group zones for synchronised playback `{ zone_ids[] }` |
| POST | `/api/ungroup` | Ungroup zones `{ zone_ids[] }` |
| POST | `/api/transfer` | Move queue from one zone to another `{ from_zone_id, to_zone_id }` |

### Playing albums with /api/play-album

If you want to play a complete album, use the dedicated `play-album` endpoint. It navigates Roon's full browse hierarchy — Search → Albums → Album page → Play Album → action — and triggers album-level playback, which natively queues every track in the correct order:

```bash
curl -X POST http://YOUR_NAS_IP:3001/api/play-album \
  -H "Content-Type: application/json" \
  -d '{
    "zone_id": "YOUR_ZONE_ID",
    "query": "Arctic Monkeys AM",
    "action": "Play Now"
  }'
```

```json
{ "success": true, "album": "AM", "artist": "Arctic Monkeys", "action": "list" }
```

This is important because Roon's album browse hierarchy is deeper than you'd expect. An album search result requires multiple levels of navigation before you reach the actual playback actions. The `find-and-play` endpoint only plays the first track of an album, and the `playlist` endpoint searches tracks individually (which can return versions from different albums or compilations). The `play-album` endpoint solves both problems by using Roon's own album-level "Play Now".

### Playing single tracks with /api/find-and-play

This is the workhorse for single track playback. Give it a natural language query, a zone, and an action — it handles the full Roon browse session internally:

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

#### Avoiding cover versions

One subtlety worth knowing: Roon's search often ranks cover recordings and live versions above the original artist, especially for well-known tracks. The extension handles this with an optional `artist` field:

```bash
curl -X POST http://YOUR_NAS_IP:3001/api/find-and-play \
  -H "Content-Type: application/json" \
  -d '{
    "zone_id": "YOUR_ZONE_ID",
    "query": "The Sound of Silence Simon and Garfunkel",
    "type": "Tracks",
    "artist": "Simon & Garfunkel",
    "action": "Play Now"
  }'
```

When `artist` is present, the API does a case-insensitive match against Roon's artist field and picks the first result where the artist name appears — skipping orchestral covers, tribute acts, and live recordings by other artists. If no match is found it falls back to Roon's top result, so including `artist` is always safe.

The same field works on individual entries in the `/api/playlist` tracks array.

#### Roon's exact action labels

This is the thing that trips everyone up. Roon uses its own internal action strings, and wrong ones silently fall back to Play Now:

| What you want | Use this string |
|---------------|----------------|
| Play immediately (clears queue) | `Play Now` |
| Add to end of queue | `Queue` ← **NOT** "Add to Queue" |
| Play after current track | `Add Next` ← **NOT** "Play Next" |
| Start Roon Radio | `Start Radio` |

The `/api/inspect` endpoint was built specifically to debug this — it shows every action Roon offers at each navigation level for any track.

#### Adding to the queue without replacing it

This is a common source of confusion. If you want to **add tracks to an existing queue** without clearing what's already there, you must use `find-and-play` with `action: "Queue"` in a loop — one call per track:

```bash
for song in "Yesterday" "Help" "Blackbird"; do
  curl -s -X POST http://YOUR_NAS_IP:3001/api/find-and-play \
    -H "Content-Type: application/json" \
    -d "{\"zone_id\":\"YOUR_ZONE_ID\",\"query\":\"$song\",\"type\":\"Tracks\",\"artist\":\"The Beatles\",\"action\":\"Queue\"}"
  sleep 0.5
done
```

Or in Python (recommended, handles apostrophes cleanly):

```python
import json, subprocess, time

tracks = [('Yesterday', 'The Beatles'), ('Help!', 'The Beatles'), ('Jolene', 'Dolly Parton')]
for song, artist in tracks:
    payload = {'zone_id': 'YOUR_ZONE_ID', 'query': song, 'type': 'Tracks',
               'artist': artist, 'action': 'Queue'}
    subprocess.run(['curl','-s','-X','POST','http://YOUR_NAS_IP:3001/api/find-and-play',
                    '-H','Content-Type: application/json','-d',json.dumps(payload)],
                   capture_output=True, text=True, timeout=10)
    time.sleep(0.5)
```

**Do NOT use `/api/playlist` for this** — it always calls `Play Now` for the first track, which clears the existing queue. `/api/playlist` is the right choice when you want to replace the queue with a fresh set of tracks. To add an entire album without replacing the queue, use `play-album` with `action: "Queue"`.

### Queuing playlists with /api/playlist

The `/api/playlist` endpoint lets you queue a list of tracks in one API call. The first track plays immediately (replacing any existing queue), and the rest are appended in order:

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

#### A word on what the Extension API can't do

Digging into the API reveals a few firm limitations worth knowing before you try to work around them:

**Playlist management** — The Extension API does not expose "Add to Playlist" or "Create Playlist" to third-party extensions. Only playback actions are available. Workaround: queue your tracks via the API, then in the Roon app go **Queue → ⋮ → Save Queue as Playlist**. One tap.

**Queue clearing** — There is no direct way to clear the queue via the Extension API. The `hierarchy:'browse'` root has no Queue item, and `hierarchy:'queue'` returns `InvalidHierarchy`. The only way to replace the queue is to use `Play Now` on any track or album — it atomically clears and replaces the queue in one step.

**Profile switching** — User profiles are per-Roon-Remote (the phone/tablet app) and cannot be changed by an extension. You can read the profile list, but not switch the active one.

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

## Multi-room control

The extension exposes the full set of `RoonApiTransport` zone management methods, so Claude can handle multi-room requests naturally:

```bash
# Sync the kitchen and living room
curl -X POST http://YOUR_NAS_IP:3001/api/group \
  -H "Content-Type: application/json" \
  -d '{ "zone_ids": ["KITCHEN_ZONE_ID", "LIVING_ROOM_ZONE_ID"] }'

# Move the queue from the living room to the office seamlessly
curl -X POST http://YOUR_NAS_IP:3001/api/transfer \
  -H "Content-Type: application/json" \
  -d '{ "from_zone_id": "LIVING_ROOM_ZONE_ID", "to_zone_id": "OFFICE_ZONE_ID" }'

# Mute just the kitchen
curl -X POST http://YOUR_NAS_IP:3001/api/mute \
  -H "Content-Type: application/json" \
  -d '{ "zone_id": "KITCHEN_ZONE_ID", "mute": true }'

# Pause everything at once
curl -X POST http://YOUR_NAS_IP:3001/api/pause/all \
  -H "Content-Type: application/json" -d '{}'
```

With the Cowork skill installed, all of this is available through natural language: "sync the kitchen and family room", "move the music to the office", "mute the kitchen", "pause everything".

## Possible Extensions

A few ideas for taking this further:

- **Now Playing webhook**: Use `subscribe_zones` to push zone state changes to Home Assistant, a dashboard, or any webhook endpoint
- **Mood-based radio**: Feed the AI your listening history and let it construct a queue based on mood or energy level
- **Voice control**: Wrap the API with a HomeKit/Shortcuts integration for Siri control

---

## Resources

- **Source code**: [github.com/andyrat33/roon-controller](https://github.com/andyrat33/roon-controller)
- **RoonLabs API repos**: [github.com/RoonLabs](https://github.com/RoonLabs)
- **Roon Extension documentation**: [roonlabs.github.io/node-roon-api](https://roonlabs.github.io/node-roon-api)
- **Roon Community**: [community.roonlabs.com](https://community.roonlabs.com)

---

*Built and tested with Roon Core on QNAP, Docker on QNAP Container Station, and Claude via Anthropic's Cowork desktop tool.*
