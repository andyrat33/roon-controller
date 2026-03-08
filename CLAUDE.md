# CLAUDE.md — Roon Controller

This file documents the setup, architecture, and change history of the Roon Controller, intended for use by Claude (via Cowork) to understand the project context.

---

## What This Project Does

A Node.js REST API that runs in Docker on a QNAP NAS and exposes Roon's Extension API over HTTP. This lets Claude (via the Cowork desktop app) control Roon playback using natural language — searching the library, queuing tracks, managing volume, and more.

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| QNAP NAS IP | `172.31.254.142` |
| API base URL | `http://172.31.254.142:3001/api` |
| Container name | `roon-controller` |
| Docker network | `host` (required for Roon SOOD/UDP discovery) |
| Auth persistence | Docker volume `roon_auth` → `/app/.roon` |
| Roon Core | QNAP (`core_id: 93508a46-d3ea-4257-bab7-5bd7a6d7f897`) |

### Updating the container

The `extension.js` is mounted as a volume — **no rebuild needed** after edits:

```bash
scp extension.js admin@172.31.254.142:/path/to/roon-controller/extension.js
ssh admin@172.31.254.142 "docker restart roon-controller"
```

---

## Roon Zones

| Zone | ID |
|------|----|
| Family Room | `160100f605727471ed0b734d13d78a92c24c` |
| Living Room | `16016deb46a7749599856dbb8deea70cad17` |
| Office | `160170f12687683c6501b7831b991e9a2a49` |
| Kitchen | `16015aafa866714e8cb0142b55371109c94d` |
| Hegel | `1601263ad0b4da78019b79485617433fd073` |
| Andy MacBookPro | `16012c2dda4d228ac5346bf95a34b51ac545` |
| MacBookPro System Out | `16017f6f2bfe4806601a698b32a037d65d91` |

---

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Health check, all zones and now-playing state |
| GET | `/api/zones` | Zone list with IDs and output info |
| GET | `/api/search?q=<query>[&type=Tracks\|Albums\|Artists]` | Search library + TIDAL |
| GET | `/api/browse[?item_key=<key>]` | Navigate library hierarchy |
| GET | `/api/tidal/search?q=<query>` | Search TIDAL directly |
| GET | `/api/inspect?q=<query>` | Debug: show exact Roon action names for a track |
| POST | `/api/find-and-play` | Search and play in one call |
| POST | `/api/play` | Play by item_key |
| POST | `/api/transport` | Playback control (play/pause/skip etc.) |
| POST | `/api/shuffle` | Enable/disable shuffle for a zone |
| POST | `/api/volume` | Set volume for a zone |
| POST | `/api/seek` | Seek within current track |
| GET | `/api/queue/:zone_id` | View current queue |
| POST | `/api/playlist` | Queue multiple tracks in order |
| POST | `/api/play-album` | Search and play an entire album natively |
| GET | `/api/profiles` | List profiles and which is active (read-only) |
| POST | `/api/queue/clear` | Clear the queue for a zone |

---

## Key API Details

### find-and-play
```json
{ "zone_id": "...", "query": "...", "type": "Tracks", "action": "Play Now" }
```

| Action string | Effect |
|---------------|--------|
| `Play Now` | Clears queue, plays immediately |
| `Queue` | Appends to end of queue |
| `Add Next` | Plays after current track |
| `Start Radio` | Starts Roon Radio from this track |

### transport
```json
{ "zone_id": "...", "action": "next" }
```
Valid actions: `play`, `pause`, `stop`, `next`, `previous`, `toggle_play_pause`

### shuffle
```json
{ "zone_id": "...", "shuffle": true }
```

### volume
```json
{ "zone_id": "...", "how": "absolute", "value": 40 }
```
`how` options: `absolute`, `relative`, `relative_step`. Range: 0–100.

### playlist
```json
{
  "name": "My Playlist",
  "zone_id": "...",
  "tracks": [
    { "query": "Song Title Artist" },
    { "query": "Another Song Artist" }
  ]
}
```
First track uses `Play Now`, subsequent tracks use `Queue` with a 2-second delay between calls. To save as a permanent Roon playlist: **Queue → ⋮ → Save Queue as Playlist**.

### play-album
```json
{ "zone_id": "...", "query": "Artist Album", "action": "Play Now" }
```
Searches for an album, navigates the full Roon browse hierarchy (Search → Albums → Album page → Play Album → action), and triggers the album-level action. This queues **all tracks** natively in the correct album order — unlike `find-and-play` which only plays a single track, or `playlist` which searches tracks individually and may return wrong versions.

Supports the same action strings as `find-and-play`: `Play Now`, `Queue`, `Add Next`, `Start Radio`.

---

## Cowork Skill

The `cowork-skill/roon/SKILL.md` file is the Claude Cowork skill definition. It must be installed in the Cowork skills plugin directory to enable natural language Roon control.

**Important:** Cowork currently resets the skills plugin directory on app updates, wiping user-installed skills. The skill needs to be re-registered after each Cowork update. This is a known bug — reported to Anthropic.

### How Claude calls the API from Cowork

Python cannot reach the QNAP from within Cowork's Linux VM sandbox. All API calls must go via `osascript` on the Mac host. The recommended pattern to avoid apostrophe quoting issues:

```applescript
do shell script "python3 /dev/stdin <<'PYEOF'
import json, subprocess
payload = {'zone_id': '160170f12687683c6501b7831b991e9a2a49', 'query': 'The track name', 'type': 'Tracks', 'action': 'Play Now'}
with open('/tmp/rp.json', 'w') as f: json.dump(payload, f)
r = subprocess.run(['curl','-s','-X','POST','http://172.31.254.142:3001/api/find-and-play','-H','Content-Type: application/json','-d','@/tmp/rp.json'], capture_output=True, text=True)
print(r.stdout)
PYEOF"
```

---

## Roon Extension API Notes

- The Roon Extension API does **not** expose playlist management (create/add to playlist) to third-party extensions. Only playback actions are available. The queue-then-save workflow is the supported path.
- The Roon Extension API does **not** support profile switching. Profiles are tied to Roon Remotes (apps on phones/tablets), and the Extension API runs as a separate client — it cannot change the active profile for any Roon Remote. The `/api/profiles` endpoint can read the profile list but not switch. Profiles in this setup: James, House, Anne, Andrew, Claude.
- Roon's internal action strings are case-sensitive. Use exactly: `Play Now`, `Queue`, `Add Next`, `Start Radio`.
- Browse sessions use `multi_session_key` to keep `item_key` values valid across multiple browse/load calls within the same search context.
- The Roon Extension API does **not** support clearing the queue. The `hierarchy: 'browse'` root does not include a Queue item, and `hierarchy: 'queue'` returns `InvalidHierarchy`. The only way to replace the queue is via "Play Now" on any track or album.

---

## Change History

### Clear queue endpoint — confirmed API limitation (2026-03-08)
- `POST /api/queue/clear` investigated and confirmed: the Roon Extension API does NOT expose queue clearing to third-party extensions
- Confirmed: `hierarchy: 'browse'` root has no "Queue" item (shows only Library, Playlists, My Live Radio, Genres, TIDAL, Settings)
- Confirmed: `hierarchy: 'queue'` returns `InvalidHierarchy` — not a valid browse hierarchy
- The endpoint returns 501 with an explanation and suggests using the Roon app or "Play Now" as a workaround
- "Play Now" on any track/album atomically replaces the queue — this is the only queue-clearing mechanism the Extension API exposes
- Updated `cowork-skill/roon/SKILL.md` with guidance for Claude to handle "clear the queue" requests
- Added `clear-queue` subcommand to `roon_control.py` (also returns 501)

### Artist matching fix to prevent cover versions (2026-03-08)
- Fixed bug where `/api/find-and-play` and `/api/playlist` could select cover recordings over the original artist (e.g. Frank Chacksfield orchestral covers instead of Simon & Garfunkel)
- Added `pickBestMatch(items, index, artist)` helper in `extension.js` — case-insensitive substring match on Roon's `subtitle` (artist) field, falls back to index-based selection if no match
- `find-and-play` now accepts optional `"artist"` in request body
- `playlist` now accepts optional `"artist"` per track entry `{ query, type?, artist? }`
- Both changes are backward-compatible — omitting `artist` preserves existing behaviour
- Updated `cowork-skill/roon/SKILL.md` to instruct Claude to always pass `artist` when playing tracks for a specific artist
- No Docker rebuild required — `extension.js` is volume-mounted; restart only

### Fix urllib.parse import crash on Python 3.13 (2026-03-08)
- Moved `import urllib.parse` to top-level imports in `roon_control.py`
- Removed misplaced inline imports from inside `_get()` and `_post()`
- Bug: Python 3.12+ (PEP 709 inlined comprehensions) treated `urllib` as an unassigned local variable, crashing with `NameError` when search params were passed
- Reported by community member on Roon Labs forum

### Profiles investigation (2026-03-06)
- Investigated whether Roon user profiles can be switched via the Extension API
- Added `GET /api/profiles` to list available profiles and show which is active
- Confirmed via browse hierarchy exploration (Root → Settings → Profile) that profile list is accessible, profiles are: James, House, Anne, Andrew, Claude
- Profile **switching** is not possible — the Extension API runs as a separate client from Roon Remotes, and profile selection is per-Remote only; browse-based switching only affects the extension's own session context, not the global Roon state
- Documented limitation in Roon Extension API Notes

### Play-album endpoint (2026-03-06)
- Added `POST /api/play-album` to `extension.js` — plays an entire album natively via Roon's browse hierarchy
- Roon's album browse requires traversing multiple levels: Search → Albums → Album container → Album page (with "Play Album" action_list) → Actions (Play Now, Queue, etc.)
- The endpoint recursively navigates up to 5 levels deep until it finds action items with `hint: "action"`
- Unlike `find-and-play` (which only plays the first track of an album) or `playlist` (which searches tracks individually and may match wrong versions), this uses Roon's native album-level playback
- Updated CLAUDE.md and cowork-skill/roon/SKILL.md to document the endpoint
- No Docker rebuild required — `extension.js` is volume-mounted; restart only

### Shuffle endpoint (2026-03-05)
- Added `POST /api/shuffle` to `extension.js` using `_transport.change_settings(zone_id, { shuffle: bool }, cb)`
- Updated `cowork-skill/roon/SKILL.md` to document the endpoint
- No Docker rebuild required — `extension.js` is volume-mounted; restart only

### Cowork skill installation (2026-03-05)
- Created `cowork-skill/roon/SKILL.md` with full API documentation, zone table, and osascript patterns
- Registered skill in Cowork manifest (`creatorType: user`)
- Populated all 7 zone IDs by querying `/api/zones` live from the running container

### Roon authorisation

If the API returns `"Not connected to Roon Core"`:

→ Roon → Settings → Extensions → Enable **"Cowork Controller"**

Auth persists across container restarts via the `roon_auth` Docker volume.
