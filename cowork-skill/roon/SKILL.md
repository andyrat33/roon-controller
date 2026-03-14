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

> ⚠️ **STOP. Read this before writing any code.**
>
> You are running in a **Linux sandbox**. You CANNOT reach `172.31.254.142` directly.
> Every one of these will fail — do not attempt them:
> - `urllib.request.urlopen(...)` → 403 Forbidden / No route to host
> - `requests.get(...)` → 403 Forbidden
> - `curl` in bash or Python subprocess → 403 Forbidden
> - Running `osascript` as a shell command → `/bin/sh: osascript: not found`
>
> **The ONLY working method is the Cowork `osascript` tool.**
>
> `osascript` is a **Cowork plugin tool** — you call it the same way you call
> `web_search` or `python`. It is NOT a shell command. Do NOT run it in bash or
> subprocess. Just call the tool directly with AppleScript as the input. The tool
> executes on the Mac host outside the sandbox, where the network is available.

---

### macOS — call the osascript tool directly

Call the `osascript` tool with AppleScript.

**GET:**
```applescript
do shell script "curl -s 'http://YOUR_NAS_IP:3001/api/status'"
```

**POST — use Python + subprocess + json.dumps() (recommended):**

This is the most reliable pattern. Python handles apostrophes natively; `json.dumps()`
serialises the payload correctly; `subprocess` with a list passes JSON to curl as a
single argument without any shell interpretation.

```applescript
do shell script "python3 /dev/stdin << 'PYEOF'
import json, subprocess
payload = {'zone_id': 'YOUR_ZONE_ID', 'query': \"Don't Stop Believin'\", 'type': 'Tracks', 'artist': \"Journey\", 'action': 'Play Now'}
r = subprocess.run(['curl','-s','-X','POST','http://YOUR_NAS_IP:3001/api/find-and-play','-H','Content-Type: application/json','-d',json.dumps(payload)], capture_output=True, text=True, timeout=5)
print(r.stdout)
PYEOF"
```

**Quoting rules for the Python dict:**
- Values that may contain apostrophes → use `\"...\"` (double-quoted Python string, `"` escaped for AppleScript)
- Values with no apostrophes → use `'...'` (single-quoted Python string)
- Booleans → `True` / `False` (Python, not JSON `true`/`false` — `json.dumps()` converts them)

**DO NOT:**
- Use `quoted form of` — apostrophes break the shell command
- Construct JSON by string concatenation across quoting layers — apostrophes corrupt the payload
- Use nested heredocs (heredoc inside a heredoc) — AppleScript parser error `-2740`
- Use multi-line AppleScript with `¬` — line continuations break as a single `-e` argument
- Use double base64 encoding — do NOT base64-encode a script that already contains base64 data; the double-encoding corrupts the payload and causes `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xc2`
- Write long heredoc scripts (>~8 lines) — `do shell script` with a multi-line heredoc fails with AppleScript error `-2741` for longer scripts; use `/api/playlist` for multi-track work instead

### CRITICAL — "Tool result missing" does NOT mean the call failed

> ⚠️ If the osascript tool returns **`"Tool result missing due to internal error"`**, this
> almost certainly means the osascript tool timed out (~10s) while your Python script was
> still running in the background. **The tracks are likely already queued.**
>
> **Rule: After any ambiguous failure (tool timeout, "result missing", no response), ALWAYS
> call `GET /api/queue/<zone_id>` and check the queue state before queuing anything else.**
> Do NOT retry blindly — you will duplicate all the tracks you just queued.

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
| POST | `/api/queue/clear` | **Clear the queue** — removes all queued tracks |
| POST | `/api/playlist` | Queue multiple tracks in order (save as playlist in Roon app) |
| GET | `/api/inspect?q=<query>` | Debug: show Roon's exact action names for a track |
| POST | `/api/shuffle` | Enable or disable shuffle for a zone |
| POST | `/api/play-album` | **Play an entire album** — natively queues all tracks in order |
| POST | `/api/mute` | Mute or unmute a zone |
| POST | `/api/mute/all` | Mute or unmute every zone at once |
| POST | `/api/pause/all` | Pause all zones simultaneously |
| POST | `/api/standby` | Toggle standby on a zone's output |
| POST | `/api/group` | Group zones for synchronised multi-room playback |
| POST | `/api/ungroup` | Ungroup zones previously grouped |
| POST | `/api/transfer` | Move the current queue from one zone to another |

---

## play-album (album playback)

**Use this endpoint when the user asks to play an album.** Do NOT use `find-and-play` for albums — it only plays the first track.

```json
{ "zone_id": "...", "query": "Artist Album", "action": "Play Now" }
```

Searches for the album, navigates Roon's full browse hierarchy (Search → Albums → Album page → Play Album → action), and triggers album-level playback. All tracks are queued natively in the correct album order.

Supports the same action strings: `Play Now`, `Queue`, `Add Next`, `Start Radio`.

```applescript
do shell script "cat > /tmp/roon_api.json << 'EOF'
{
  \"zone_id\": \"YOUR_ZONE_ID\",
  \"query\": \"Arctic Monkeys AM\",
  \"action\": \"Play Now\"
}
EOF
curl -s -X POST http://YOUR_NAS_IP:3001/api/play-album -H 'Content-Type: application/json' -d @/tmp/roon_api.json"
```

---

## find-and-play (single track playback)

```json
{ "zone_id": "...", "query": "...", "type": "Tracks", "action": "Play Now" }
```

### Avoiding cover versions — always pass `artist`

When the user asks to play a track by a specific artist, **always include `"artist"`** in
the request. The API matches this against Roon's subtitle field (which contains the artist
name), filtering out cover versions and live recordings by other artists that Roon may rank
higher in search results.

```json
{
  "zone_id": "...",
  "query": "The Sound of Silence Simon and Garfunkel",
  "type": "Tracks",
  "artist": "Simon & Garfunkel",
  "action": "Play Now"
}
```

If no subtitle match is found the API falls back to Roon's top result — so passing `artist`
is always safe and never causes a failure.

### CRITICAL — Roon's exact action labels

These are the real strings Roon uses internally. Wrong names silently fall back to Play Now.

| Want to... | Use this string |
|------------|----------------|
| Play immediately (clears queue) | `Play Now` |
| Add to end of queue | `Queue` ← **NOT** "Add to Queue" |
| Play after current track | `Add Next` ← **NOT** "Play Next" |
| Start Roon Radio | `Start Radio` |

### CRITICAL — "Add to queue" vs "Play now"

When the user says **"add to the queue"**, **"queue these songs"**, **"don't replace what's playing"**, or any similar phrasing that implies preserving the existing queue:

- **Use `find-and-play` with `action: "Queue"` for every track** — loop over tracks, first track gets `"Queue"` too
- **Do NOT use `/api/playlist`** — it always calls `Play Now` for the first track, which clears the existing queue regardless of your intent

Example loop for adding multiple artists' tracks without replacing the queue:

> ⚠️ **osascript timeout warning:** The `osascript` tool has a ~10 second timeout. For more
> than ~8 tracks this loop will exceed the timeout and osascript will appear to "fail" — but
> the Python process keeps running in the background and all tracks ARE still being queued.
> **Do NOT retry if osascript returns an error on a long loop. Check `/api/queue/<zone_id>`
> first** to see whether the tracks were queued successfully.
>
> Use `time.sleep(0.05)` not `time.sleep(0.5)` — the shorter delay keeps 20 tracks under
> ~15 seconds total and avoids spurious timeout errors.

```applescript
do shell script "python3 /dev/stdin << 'PYEOF'
import json, subprocess, time
zone_id = 'YOUR_ZONE_ID'
tracks = [
    ('Yesterday', 'The Beatles'),
    ('Help!', 'The Beatles'),
    ('Jolene', 'Dolly Parton'),
]
for song, artist in tracks:
    payload = {'zone_id': zone_id, 'query': song, 'type': 'Tracks', 'artist': artist, 'action': 'Queue'}
    subprocess.run(['curl','-s','-X','POST','http://YOUR_NAS_IP:3001/api/find-and-play',
                    '-H','Content-Type: application/json','-d',json.dumps(payload)],
                   capture_output=True, text=True, timeout=10)
    time.sleep(0.05)
print('done')
PYEOF"
```

Likewise, to **add an entire album** without replacing the queue, use `play-album` with `action: "Queue"`.

---

## Research-first strategy for complex queries

When the user asks for songs matching **chart history, era, genre, or editorial criteria**,
do NOT rely on Roon's search ranking — it is driven by library metadata and may surface
rereleases, covers, or wrong-era versions. Instead:

### When to use internet search first

Trigger `web_search` **before any Roon API call** when the query:
- References chart positions ("Top 10", "number 1", "hit", "charted")
- References a specific year, era, or decade ("1988", "summer of '69", "80s")
- References a chart or market ("UK charts", "Billboard Hot 100")
- References seasons/time periods ("summer hits", "Christmas number ones")
- Is historically or culturally framed ("songs everyone knew in 1992")
- Involves a "best of", "classic", or editorial-style list

Do NOT trigger internet search for:
- User names a specific song + artist directly
- User asks to play an album by name
- Playback control (skip, pause, volume, etc.)
- Artist discography queries ("play all of Radiohead")

### Step 1 — Search the internet first

Use `web_search` to resolve the exact tracks before calling Roon. Examples:

| User request | Search query |
|---|---|
| "Top 10 UK hits, summer 1988" | `UK Top 10 singles July August 1988 official charts` |
| "10 number ones from the 70s" | `UK number one singles 1970s list` |
| "Christmas number ones" | `UK Christmas number one singles list` |
| "Best Britpop songs" | `Britpop essential songs list Oasis Blur Pulp` |

Prefer authoritative sources: officialcharts.com, Wikipedia chart lists, Billboard archives.

### Step 2 — Build the playlist from research

Once you have exact titles and original artists, use `/api/playlist` with `artist` on
every track. This filters out covers and rereleases that Roon may rank higher.

**IMPORTANT:** Put only the **song title** in `query` — do NOT include the artist name
in the query string. Karaoke and tribute tracks often include the original artist name
in their track title (e.g. `"...made popular by Yazz..."`), which causes them to rank
highly when the artist name appears in the query. The `artist` field handles filtering
separately, so adding it to `query` only helps cover versions win.

```json
POST /api/playlist
{
  "name": "Summer 1988 UK Top 10",
  "zone_id": "YOUR_ZONE_ID",
  "tracks": [
    { "query": "The Only Way Is Up",       "artist": "Yazz" },
    { "query": "A Groovy Kind of Love",    "artist": "Phil Collins" },
    { "query": "I Should Be So Lucky",     "artist": "Kylie Minogue" },
    { "query": "Nothing's Gonna Stop Us Now", "artist": "Starship" }
  ]
}
```

### Step 3 — Tell the user what you found

Before queuing, briefly tell the user which songs you found from your research (e.g.
"I found these 10 songs that were in the UK Top 10 during summer 1988: ..."). This
lets them correct or adjust before playback starts.

### Why this matters

Roon sorts search results by library relevance, not release date. Searching for a 1988
hit may return a 2018 remaster or a cover version ranked above the original. Internet
search gives you the canonical title + original artist, and the `artist` field in the
playlist payload ensures Roon selects the right version.

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
do shell script "cat > /tmp/roon_api.json << 'EOF'
{
  \"zone_id\": \"YOUR_ZONE_ID\",
  \"shuffle\": true
}
EOF
curl -s -X POST http://YOUR_NAS_IP:3001/api/shuffle -H 'Content-Type: application/json' -d @/tmp/roon_api.json"
```

## queue/clear

Use this when the user wants to clear the queue, empty the queue, or remove all queued tracks.

```json
{ "zone_id": "..." }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/queue/clear -H 'Content-Type: application/json' -d '{\"zone_id\":\"YOUR_ZONE_ID\"}'"
```

---

## mute

Use this to **mute or unmute a specific zone**. Prefer mute over setting volume to 0 — mute preserves the volume level so it can be restored unchanged.

Triggers: "mute the kitchen", "unmute the living room", "silence the office"

```json
{ "zone_id": "...", "mute": true }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/mute -H 'Content-Type: application/json' -d '{\"zone_id\":\"YOUR_ZONE_ID\",\"mute\":true}'"
```

---

## mute/all

Mute or unmute **every zone at once**.

Triggers: "mute everything", "unmute all rooms", "silence all zones"

```json
{ "mute": true }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/mute/all -H 'Content-Type: application/json' -d '{\"mute\":true}'"
```

---

## pause/all

**Pause every zone simultaneously.** No body required.

Triggers: "pause all music", "stop everything", "quiet please", "pause all rooms"

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/pause/all -H 'Content-Type: application/json' -d '{}'"
```

---

## standby

**Toggle standby** on a zone's output (puts a connected AV device into standby or wakes it). Behaviour depends on whether the output supports standby control (e.g. CEC-enabled displays or Roon-ready devices).

Triggers: "put the office to sleep", "standby the living room", "turn off the hegel"

```json
{ "zone_id": "..." }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/standby -H 'Content-Type: application/json' -d '{\"zone_id\":\"YOUR_ZONE_ID\"}'"
```

---

## group

**Sync two or more zones** so they play the same music in perfect time. Pass an array of at least 2 zone IDs. The zones will merge into a single grouped zone.

Triggers: "play in both the kitchen and living room", "sync the family room and kitchen", "group all the downstairs zones"

```json
{ "zone_ids": ["zone_id_1", "zone_id_2"] }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/group -H 'Content-Type: application/json' -d '{\"zone_ids\":[\"ZONE_ID_1\",\"ZONE_ID_2\"]}'"
```

---

## ungroup

**Remove zones from a group** so they play independently again.

Triggers: "ungroup the kitchen", "separate the zones", "stop syncing the rooms"

```json
{ "zone_ids": ["zone_id_1"] }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/ungroup -H 'Content-Type: application/json' -d '{\"zone_ids\":[\"YOUR_ZONE_ID\"]}'"
```

---

## transfer

**Move the current queue from one zone to another.** The music stops in the source zone and continues seamlessly in the destination zone from the same point.

Triggers: "move the music to the kitchen", "transfer to the office", "continue playing in the living room", "bring the music upstairs"

```json
{ "from_zone_id": "...", "to_zone_id": "..." }
```

```applescript
do shell script "curl -s -X POST http://YOUR_NAS_IP:3001/api/transfer -H 'Content-Type: application/json' -d '{\"from_zone_id\":\"FROM_ZONE_ID\",\"to_zone_id\":\"TO_ZONE_ID\"}'"
```

---

## volume

```json
{ "zone_id": "...", "how": "absolute", "value": 40 }
```

Range 0–100. `how`: `absolute`, `relative`, `relative_step`

---

## Playlist pattern

### When to use which approach

| Situation | Use |
|-----------|-----|
| Playing/replacing queue with 1–100 tracks | `/api/playlist` — single API call, handles all quoting |
| Adding to existing queue, ≤5 tracks | `find-and-play` loop with `action: "Queue"` |
| Adding to existing queue, >5 tracks | `find-and-play` loop — osascript may timeout, **check queue before retrying** |
| Playing an entire album | `/api/play-album` |

**For large track counts always prefer `/api/playlist`** — it's a single osascript call (~5s for 20 tracks), handles quoting safely via `json.dumps()`, and has a server-side idempotency guard. The `find-and-play` loop is only needed when you must preserve an existing queue.

### Option A — /api/playlist (recommended for multi-track lists)

Queues all tracks in one API call. First track plays immediately, rest are queued.
Always include `"artist"` per track to prevent cover versions. Put only the
**song title** in `query` — do NOT include the artist name there (tribute/karaoke
tracks embed the original artist in their title, making them rank above originals).

> ⚠️ **Call this endpoint exactly once and wait for the full JSON response.**
> For a 20-track playlist it takes ~5 seconds. The first song starting to play
> does NOT mean the call is finished — the endpoint is still queuing remaining
> tracks. A second call within 30 seconds is rejected with HTTP 409 (server-side
> idempotency guard). Success: `"queued" === "total"` in the response.
>
> If osascript appears to time out or return an error, **check `/api/queue/<zone_id>`
> before retrying** — the playlist may have queued successfully in the background.
> A duplicate call within 30s will be rejected with HTTP 409, but after 30s a
> duplicate call will queue everything again.

```applescript
do shell script "python3 /dev/stdin << 'PYEOF'
import json, subprocess
payload = {
    'name': 'My Playlist',
    'zone_id': 'YOUR_ZONE_ID',
    'tracks': [
        {'query': 'The Sound of Silence', 'artist': 'Simon & Garfunkel'},
        {'query': \"Don't You Want Me\",   'artist': 'Human League'},
        {'query': 'Hotel California',     'artist': 'Eagles'},
    ]
}
r = subprocess.run(
    ['curl','-s','-X','POST','http://YOUR_NAS_IP:3001/api/playlist',
     '-H','Content-Type: application/json','-d',json.dumps(payload)],
    capture_output=True, text=True, timeout=60
)
print(r.stdout)
PYEOF"
```

To save as a permanent Roon playlist: **Queue → ⋮ → Save Queue as Playlist**.

> **Note:** Roon's Extension API does not expose "Add to Playlist" to third-party
> extensions — only playback actions are available. The queue-then-save workflow
> is the supported path.

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
