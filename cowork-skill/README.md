# Roon Cowork Skill

This folder contains a [Claude Cowork](https://claude.ai) skill that lets you control Roon with natural language — no typing commands, no scripts. Just tell Cowork what you want to hear.

> **What is Cowork?** It's Anthropic's Claude desktop app with agentic capabilities. The skill system lets Claude automatically know how to interact with your Roon system in any new session.

## What you can say

- *"Play some Kate Bush in the living room"*
- *"Queue up 3 Dire Straits classics in the office"*
- *"What's playing in the kitchen?"*
- *"Turn the volume up to 40 in the bedroom"*
- *"Skip this track"*
- *"Put something relaxing on"*
- *"Make me an 80s playlist, one song per year"*

## Prerequisites

1. Docker running on your NAS or server (see main repo README)
2. The `roon-controller` container up and authorised in Roon
3. Claude Cowork installed on your Mac — [claude.ai](https://claude.ai)

## Installation

### Step 1 — Copy the skill

Copy the `roon/` folder to your Cowork skills directory:

```bash
# Find your skills path — it looks like this:
~/Library/Application\ Support/Claude/local-agent-mode-sessions/skills-plugin/<uuid>/<uuid>/skills/

# Copy the skill folder there:
cp -r roon/ "~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/<your-uuid>/<your-uuid>/skills/"
```

Or use Finder: navigate to `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/` and copy the `roon/` folder into the `skills/` subfolder.

> **Tip:** Press `Cmd+Shift+G` in Finder and paste the path to navigate there.

### Step 2 — Edit SKILL.md with your details

Open `roon/SKILL.md` and replace the placeholders:

| Placeholder | Replace with |
|------------|--------------|
| `YOUR_NAS_IP` | Your NAS/server local IP (e.g. `192.168.1.100`) |
| `YOUR_ZONE_NAME` / `YOUR_ZONE_ID` | Your Roon zone names and IDs (see below) |
| Library/taste section | Your own music library and preferences |

**Getting your zone IDs** — once the container is running, call:
```bash
curl http://YOUR_NAS_IP:3001/api/zones
```
This returns all your Roon zones with their IDs. Add them to the Zones table in SKILL.md.

### Step 3 — Restart Cowork

Quit and reopen the Claude desktop app. The Roon skill will appear automatically and activate whenever you ask about music.

## How it works

The skill teaches Cowork three critical things that aren't obvious from Roon's docs:

1. **Use curl via AppleScript** — Python can't reach local network services from inside Cowork's sandbox, but `osascript` can.

2. **Write payloads to `/tmp/rp.json`** — avoids AppleScript quoting failures on track titles with apostrophes like *"Don't Stand So Close To Me"*.

3. **Roon's exact action strings** — Roon uses `"Queue"` not `"Add to Queue"`, and `"Add Next"` not `"Play Next"`. Wrong strings silently fall back to Play Now and break playlist queuing.

## Folder structure

```
cowork-skill/
├── README.md          ← you are here
└── roon/
    └── SKILL.md       ← the skill file (edit this with your details)
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `"Not connected to Roon Core"` | Roon → Settings → Extensions → Enable "Cowork Controller" |
| Curl times out | Check the container is running: `docker ps` on your NAS |
| Wrong track plays | Use `/api/inspect?q=<track>` to see Roon's actual action labels |
| All tracks play immediately instead of queuing | Ensure subsequent tracks use `"Queue"` not `"Add to Queue"` |

## Credits

Built by [@andyrat33](https://github.com/andyrat33) with Claude Cowork.
Roon node packages by [RoonLabs](https://github.com/RoonLabs).
