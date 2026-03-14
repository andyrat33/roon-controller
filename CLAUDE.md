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
| POST | `/api/mute` | Mute/unmute a zone |
| POST | `/api/mute/all` | Mute/unmute all zones |
| POST | `/api/pause/all` | Pause all zones simultaneously |
| POST | `/api/standby` | Toggle standby on a zone's output |
| POST | `/api/group` | Group zones for synchronised playback |
| POST | `/api/ungroup` | Ungroup zones |
| POST | `/api/transfer` | Transfer queue from one zone to another |

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
- The `/api/standby` endpoint requires `control_key` from the output's `source_controls` — passing `{}` causes `InvalidRequest`. The endpoint now finds the first `source_control` with `supports_standby: true` and passes its `control_key` automatically. Confirmed working: Hegel H390 enters standby correctly.

---

## Change History

### Fix osascript timeout causing queue duplication on long loops (2026-03-14)
- Root cause: SKILL.md loop example used `time.sleep(0.5)` between tracks. For 20 tracks this takes ~15s+, exceeding the Cowork osascript tool's ~10s timeout. osascript returned a "failure" but the Python process kept running in the background, successfully queuing all 20 tracks. Haiku retried ~5 times → ~100 tracks queued.
- Fix 1: Changed `time.sleep(0.5)` → `time.sleep(0.05)` in the "Add to queue" loop example in SKILL.md
- Fix 2: Added warning block to the loop section: if osascript appears to fail on a long loop, check `/api/queue/<zone_id>` before retrying — do NOT retry blindly
- Fix 3: Added same "check queue before retrying" warning to the `/api/playlist` Option A section

### Fix "add to queue" — SKILL.md guidance for preserving existing queue (2026-03-13)
- Root cause: when asked to "add to the queue without replacing", Haiku used `/api/playlist`, which always calls `Play Now` for the first track and clears the existing queue
- Fix: added a `CRITICAL — "Add to queue" vs "Play now"` section to `SKILL.md` immediately after the action labels table
- Rule: "add to queue" must use `find-and-play` with `action: "Queue"` in a loop for every track — `/api/playlist` is explicitly called out as wrong for this use case
- Same principle for albums: `play-album` with `action: "Queue"`
- Confirmed working

### Server-side idempotency guard for /api/playlist (2026-03-12)
- SKILL.md warning (2026-03-11) was insufficient — needed a server-side fix
- Added two-layer guard in `extension.js`:
  - **Layer 1 (in-flight lock):** per-zone `_playlistInFlight` Map — rejects any concurrent second call with `409 reason: "in_flight"` while the first is still running
  - **Layer 2 (payload dedup):** after completion, stores a hash of `zone_id + track queries` in `_playlistRecentHashes` with a 30s TTL — rejects identical requests within that window with `409 reason: "duplicate"` and `age_seconds`
  - Lazy TTL cleanup on each request; lock always released in try/catch (failed calls are retryable, not hashed)
- Confirmed working: 20-track playlist queued 20/20; immediate second call rejected with `{"reason":"duplicate","age_seconds":0}`

### Fix /api/playlist double-call by Haiku (2026-03-11)
- Root cause: Haiku called `/api/playlist` twice per request (confirmed in docker logs: 2× `[playlist] START` per playlist). The second call's `Play Now` for track[0] cleared the queue built by the first call, causing the "songs skipped / restarts" glitch.
- The extension was working correctly — the bug was Haiku issuing a redundant second call, likely because the request takes ~5s for a 20-track playlist and Haiku treated the first song starting to play as a completion signal.
- Fix: added an `⚠️` warning block in `cowork-skill/roon/SKILL.md` immediately before the Option A code example, stating: the call is long-running, playback starting ≠ call done, call exactly once, a second call clears the queue, success = `queued === total`.

### Fix /api/standby: pass control_key to toggle_standby (2026-03-11)
- Root cause of `InvalidRequest`: `toggle_standby` requires `{ control_key }` in the options object; we were passing `{}`
- Fix: find the first `source_control` with `supports_standby: true` on the output, pass its `control_key`
- Added 400 response if no standby-capable source_control exists
- Confirmed working: Hegel H390 enters standby correctly
- SSH access to QNAP now set up (`Host qnap` in `~/.ssh/config`); deploy command: `scp extension.js qnap:/share/Container/roon-controller/extension.js && ssh qnap "/share/ZFS531_DATA/.qpkg/container-station/bin/docker restart roon-controller"`

### Standby test on Hegel — initial test showed InvalidRequest (2026-03-10)
- Tested `POST /api/standby` against the Hegel zone (`1601263ad0b4da78019b79485617433fd073`)
- Roon returns `{"error":"InvalidRequest"}` (HTTP 500) — `toggle_standby` is rejected for this output
- The Hegel amp does not expose standby control through the Roon Extension API
- The endpoint and code are correct; this is a per-output capability limitation
- Documented in Roon Extension API Notes

### Fix GET /api/queue and remove non-functional queue/clear (2026-03-08)
- Fixed `GET /api/queue/:zone_id` — was calling `_transport.get_queue()` which does not exist in `RoonApiTransport`; replaced with `_transport.subscribe_queue(zone_id, 100, cb)` which is the actual API method. Callback signature is `(response, msg)` where `response="Subscribed"` on first call and `msg.items` contains the queue. A `done` flag ignores subsequent change notifications.
- Replaced `POST /api/queue/clear` browse-based implementation with a clean 501 response — confirmed the Roon Extension API has no queue-clearing mechanism (`hierarchy:'browse'` root has no Queue item; `hierarchy:'queue'` returns `InvalidHierarchy`). Response includes a workaround hint.
- Reported by FunkBrother on Roon Community forum (post #12)

### New transport endpoints: mute, pause-all, standby, group, ungroup, transfer (2026-03-08)
- Discovered 7 undocumented `RoonApiTransport` methods from official API docs: `mute`, `mute_all`, `pause_all`, `standby`, `toggle_standby`, `group_outputs`, `ungroup_outputs`, `transfer_zone`
- Added `POST /api/mute` — mute/unmute a specific zone's output
- Added `POST /api/mute/all` — mute/unmute all zones at once
- Added `POST /api/pause/all` — pause all zones simultaneously
- Added `POST /api/standby` — toggle standby on a zone's output via `toggle_standby(output, {}, cb)`
- Added `POST /api/group` — group multiple zones' outputs for synchronised playback; accepts `zone_ids[]`, looks up first output of each zone, calls `group_outputs`
- Added `POST /api/ungroup` — ungroup zones; same lookup pattern, calls `ungroup_outputs`
- Added `POST /api/transfer` — move current queue from one zone to another via `transfer_zone(fromZone, toZone, cb)`
- Added 7 corresponding subcommands to `roon_control.py`
- Updated `cowork-skill/roon/SKILL.md` with sections for each endpoint including trigger phrases for natural language use
- No Docker rebuild required — `extension.js` is volume-mounted; restart only

### Clear queue endpoint (2026-03-08)
- Added `POST /api/queue/clear` to `extension.js` — navigates Roon's browse hierarchy to find and execute the "Clear Queue" action
- The Roon Transport API has no direct `clear_queue()` method; the endpoint uses `hierarchy: 'browse'` with `zone_or_output_id` to discover queue management actions at the root level
- Added `clear-queue` subcommand to `roon_control.py`
- Updated `cowork-skill/roon/SKILL.md` to document the endpoint
- No Docker rebuild required — `extension.js` is volume-mounted; restart only

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
