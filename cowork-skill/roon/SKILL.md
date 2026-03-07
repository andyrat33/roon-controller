---
name: roon
description: >
  Controls your Roon music system — searching the library and TIDAL, playing
  tracks, queuing playlists, adjusting volume, skipping tracks, and answering
  questions about the music library. Use this skill any time the user mentions
  Roon, wants to play music, create a playlist, control playback, adjust volume,
  skip a track, asks what's playing, or wants music recommendations based on
  their library. Trigger even for casual requests like "put something on",
  "skip this", "turn it up", or "play something relaxing" — this skill has
  full knowledge of your zones, library, and the API needed to act immediately.
---

# Roon Music Controller

Your Roon system is controlled via a REST API running in Docker on your NAS/server.

> **Before you start:** Edit this file and replace all `YOUR_*` placeholders with your
> own values. See `cowork-skill/README.md` for full setup instructions.

## API Base

```
http://YOUR_NAS_IP:3001/api
```

## CRITICAL: How to make API calls

The method depends on your operating system. Python inside Cowork's sandbox typically
cannot reach the NAS directly ("No route to host"), so you need to escape to the host.

---

### macOS — osascript (recommended)

Use `curl` via `osascript`. Write JSON payloads to `/tmp/rp.json` to avoid apostrophe
quoting issues in track titles (e.g. "Don't Stand So Close To Me").

**GET:**
```applescript
do shell script "curl -s 'http://YOUR_NAS_IP:3001/api/status'"
```

**POST:**
```applescript
set payload to "{\"zone_id\":\"YOUR_ZONE_ID\",\"query\":\"Kate Bush Running Up That Hill\",\"type\":\"Tracks\",\"action\":\"Play Now\"}"
do shell script "echo " & quoted form of payload & " > /tmp/rp.json && curl -s -X POST http://YOUR_NAS_IP:3001/api/find-and-play -H 'Content-Type: application/json' -d @/tmp/rp.json"
```

> All `osascript` / AppleScript code blocks in this file are **macOS only**.

---

### Windows — three options (try in order)

#### Option 1: Direct Python (try first)

Windows Cowork's sandbox may have different network access than macOS. Try a plain
`urllib` call — if it works, use inline Python for all calls:

```python
import urllib.request, json
with urllib.request.urlopen('http://YOUR_NAS_IP:3001/api/status', timeout=10) as r:
    print(r.read().decode())
```

For POST requests:
```python
import urllib.request, json
payload = json.dumps({"zone_id": "YOUR_ZONE_ID", "query": "Kate Bush Running Up That Hill", "type": "Tracks", "action": "Play Now"}).encode()
req = urllib.request.Request("http://YOUR_NAS_IP:3001/api/find-and-play", data=payload, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    print(r.read().decode())
```

#### Option 2: PowerShell fallback

If direct Python fails ("No route to host"), escape to the Windows host via PowerShell:

```python
import subprocess, json
payload = json.dumps({"zone_id": "YOUR_ZONE_ID", "query": "Kate Bush Running Up That Hill", "type": "Tracks", "action": "Play Now"})
r = subprocess.run(
    ["powershell", "-Command",
     f"Invoke-RestMethod -Uri http://YOUR_NAS_IP:3001/api/find-and-play "
     f"-Method POST -ContentType 'application/json' -Body '{payload}'"],
    capture_output=True, text=True
)
print(r.stdout)
```

For GET requests via PowerShell:
```python
import subprocess
r = subprocess.run(
    ["powershell", "-Command",
     "Invoke-RestMethod -Uri http://YOUR_NAS_IP:3001/api/status"],
    capture_output=True, text=True
)
print(r.stdout)
```

#### Option 3: roon_control.py via PowerShell

If `roon_control.py` is on the Windows machine, invoke it through PowerShell:

```python
import subprocess
r = subprocess.run(
    ["powershell", "-Command", "python roon_control.py status"],
    capture_output=True, text=True
)
print(r.stdout)
```

The script supports all key endpoints — see `roon_control.py --help` for the full list.

---

---

## Zones

Replace this table with your own zones. Get them by calling `/api/zones`.

| Zone | ID |
|------|----|
| YOUR_ZONE_NAME | `YOUR_ZONE_ID` |

**How to find your zone IDs:**
```applescript
do shell script "curl -s 'http://YOUR_NAS_IP:3001/api/zones'"
```

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | All zones, playback state, now playing |
| GET | `/api/zones` | Zone list with IDs |
| GET | `/api/search?q=<query>[&type=Tracks\|Albums\|Artists]` | Search library + TIDAL |
| POST | `/api/find-and-play` | **Main play endpoint** — search + play in one session |
| POST | `/api/transport` | Playback control (play/pause/skip etc.) |
| POST | `/api/volume` | Volume control |
| GET | `/api/queue/<zone_id>` | View current queue |
| POST | `/api/playlist` | Queue multiple tracks in order (save as playlist in Roon app) |
| GET | `/api/inspect?q=<query>` | Debug: show Roon's exact action names for a track |
| POST | `/api/shuffle` | Enable or disable shuffle for a zone |
| POST | `/api/play-album` | **Play an entire album** — natively queues all tracks in order |

---

## play-album (album playback)

**Use this endpoint when the user asks to play an album.** Do NOT use `find-and-play` for albums — it only plays the first track.

```json
{ "zone_id": "...", "query": "Artist Album", "action": "Play Now" }
```

Searches for the album, navigates Roon's full browse hierarchy (Search → Albums → Album page → Play Album → action), and triggers album-level playback. All tracks are queued natively in the correct album order.

Supports the same action strings: `Play Now`, `Queue`, `Add Next`, `Start Radio`.

```applescript
set payload to "{\"zone_id\":\"YOUR_ZONE_ID\",\"query\":\"Arctic Monkeys AM\",\"action\":\"Play Now\"}"
do shell script "echo " & quoted form of payload & " > /tmp/rp.json && curl -s -X POST http://YOUR_NAS_IP:3001/api/play-album -H 'Content-Type: application/json' -d @/tmp/rp.json"
```

---

## find-and-play (single track playback)

```json
{ "zone_id": "...", "query": "...", "type": "Tracks", "action": "Play Now" }
```

### CRITICAL — Roon's exact action labels

These are the real strings Roon uses internally. Wrong names silently fall back to Play Now.

| Want to... | Use this string |
|------------|----------------|
| Play immediately (clears queue) | `Play Now` |
| Add to end of queue | `Queue` ← **NOT** "Add to Queue" |
| Play after current track | `Add Next` ← **NOT** "Play Next" |
| Start Roon Radio | `Start Radio` |

---

## transport

```json
{ "zone_id": "...", "action": "next" }
```

Valid actions: `play`, `pause`, `stop`, `next`, `previous`, `toggle_play_pause`

---


---

## shuffle

```json
{ "zone_id": "...", "shuffle": true }
```

Set `shuffle` to `true` to enable, `false` to disable.

```applescript
do shell script "python3 /dev/stdin <<'PYEOF'
import json, subprocess
payload = {'zone_id': '160170f12687683c6501b7831b991e9a2a49', 'shuffle': True}
with open('/tmp/rp.json', 'w') as f: json.dump(payload, f)
r = subprocess.run(['curl','-s','-X','POST','http://172.31.254.142:3001/api/shuffle','-H','Content-Type: application/json','-d','@/tmp/rp.json'], capture_output=True, text=True)
print(r.stdout)
PYEOF"
```

## volume

```json
{ "zone_id": "...", "how": "absolute", "value": 40 }
```

Range 0–100. `how`: `absolute`, `relative`, `relative_step`

---

## Playlist pattern

### Option A — /api/playlist (recommended for multi-track lists)

Queues all tracks in one API call. First track plays immediately, rest are queued.
To save as a permanent Roon playlist: **Queue → ⋮ → Save Queue as Playlist**.

> **Note:** Roon's Extension API does not expose "Add to Playlist" to third-party
> extensions — only playback actions are available. The queue-then-save workflow
> is the supported path.

```json
POST /api/playlist
{
  "name": "My 1988 Mix",
  "zone_id": "YOUR_ZONE_ID",
  "tracks": [
    { "query": "Song One Artist One" },
    { "query": "Song Two Artist Two" },
    { "query": "Song Three Artist Three" }
  ]
}
```

Use AppleScript to call it — write the payload to a shell script to handle
any apostrophes in track titles:

```applescript
do shell script "cat > /tmp/roon_pl.sh << 'EOF'
#!/bin/bash
printf '{\"name\":\"My Playlist\",\"zone_id\":\"YOUR_ZONE_ID\",\"tracks\":[{\"query\":\"Song One Artist\"},{\"query\":\"Song Two Artist\"}]}' > /tmp/rp.json
curl -s -X POST http://YOUR_NAS_IP:3001/api/playlist -H 'Content-Type: application/json' -d @/tmp/rp.json
EOF
bash /tmp/roon_pl.sh"
```

### Option B — individual find-and-play calls (for short lists or fine control)

First track → `Play Now` (starts playback, clears existing queue).
All subsequent tracks → `Queue`. Use `delay 2` between calls.

```applescript
set zone to "YOUR_ZONE_ID"
set api to "http://YOUR_NAS_IP:3001/api/find-and-play"
set tracks to {¬
  {"Song One Artist One", "Play Now"}, ¬
  {"Song Two Artist Two", "Queue"}, ¬
  {"Song Three Artist Three", "Queue"} ¬
}
repeat with t in tracks
  set payload to "{\"zone_id\":\"" & zone & "\",\"query\":\"" & item 1 of t & "\",\"type\":\"Tracks\",\"action\":\"" & item 2 of t & "\"}"
  do shell script "echo " & quoted form of payload & " > /tmp/rp.json && curl -s -X POST " & api & " -H 'Content-Type: application/json' -d @/tmp/rp.json"
  delay 2
end repeat
```

---

## Your library and taste profile

Edit this section to describe your own library and musical taste. Cowork uses
this to make smart recommendations and playlist choices on your behalf.

```
YOUR_STREAMING_SERVICE is connected — any track can be played.

Local library includes:
- Artist — albums

Taste profile: describe your taste here so Cowork can recommend music you'll enjoy.
```

---

## Roon authorisation

If the API returns `"Not connected to Roon Core"`, you need to re-authorise:

Roon → Settings → Extensions → Enable **"Cowork Controller"**

Auth persists across container restarts (stored in Docker volume `roon_auth`).
The container is named `roon-controller` on your NAS.
