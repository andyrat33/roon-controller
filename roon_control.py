#!/usr/bin/env python3
"""
roon_control.py  —  Claude/Cowork helper for controlling Roon via the REST extension.

Usage (from terminal):
  python3 roon_control.py status
  python3 roon_control.py zones
  python3 roon_control.py search "Miles Davis" [--type tracks|albums|artists]
  python3 roon_control.py play <zone_id> <item_key> [--action "Play Now|Play Next|Add to Queue"]
  python3 roon_control.py find-and-play <zone_id> <query> [--type Tracks] [--action "Play Now"]
  python3 roon_control.py play-album <zone_id> <query> [--action "Play Now"]
  python3 roon_control.py shuffle <zone_id> <true|false>
  python3 roon_control.py playlist <zone_id> <track1> <track2> ...
  python3 roon_control.py transport <zone_id> <action>
  python3 roon_control.py volume <zone_id> <value> [--how absolute|relative]
  python3 roon_control.py queue <zone_id>

Set ROON_HOST env var or edit BASE_URL below.
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error

# ── Configuration ─────────────────────────────────────────────────────────────
# Change QNAP_IP to your QNAP's actual IP address (e.g. 192.168.1.50)
QNAP_IP  = os.environ.get('ROON_HOST', '172.31.254.142')
PORT     = os.environ.get('ROON_PORT', '3001')
BASE_URL = f'http://{QNAP_IP}:{PORT}/api'
# ──────────────────────────────────────────────────────────────────────────────


def _get(path, params=None):
    url = BASE_URL + path
    if params:
        qs = '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k, v in params.items())
        url = f'{url}?{qs}'
    import urllib.parse
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f'HTTP {e.code}: {body}', file=sys.stderr)
        sys.exit(1)
    except Exception as ex:
        print(f'Request failed: {ex}', file=sys.stderr)
        sys.exit(1)


def _post(path, payload):
    import urllib.parse
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE_URL + path,
        data=data,
        headers={'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f'HTTP {e.code}: {body}', file=sys.stderr)
        sys.exit(1)
    except Exception as ex:
        print(f'Request failed: {ex}', file=sys.stderr)
        sys.exit(1)


def cmd_status(args):
    d = _get('/status')
    print(json.dumps(d, indent=2))


def cmd_zones(args):
    zones = _get('/zones')
    for z in zones:
        np = z.get('now_playing')
        playing = f"  ▶  {np['title']} — {np['artist']}" if np else '  ⏹  (stopped)'
        print(f"[{z['zone_id']}]  {z['display_name']}  ({z['state']}){playing}")


def cmd_search(args):
    params = {'q': args.query}
    if args.type:
        params['type'] = args.type
    results = _get('/search', params)
    print(json.dumps(results, indent=2))


def cmd_play(args):
    payload = {'zone_id': args.zone_id, 'item_key': args.item_key}
    if args.action:
        payload['action'] = args.action
    result = _post('/play', payload)
    print(json.dumps(result, indent=2))


def cmd_transport(args):
    payload = {'zone_id': args.zone_id, 'action': args.action}
    result = _post('/transport', payload)
    print(json.dumps(result, indent=2))


def cmd_volume(args):
    payload = {'zone_id': args.zone_id, 'how': args.how, 'value': int(args.value)}
    result = _post('/volume', payload)
    print(json.dumps(result, indent=2))


def cmd_queue(args):
    result = _get(f'/queue/{args.zone_id}')
    print(json.dumps(result, indent=2))


def cmd_browse(args):
    params = {}
    if args.item_key:
        params['item_key'] = args.item_key
    result = _get('/browse', params)
    print(json.dumps(result, indent=2))


def cmd_find_and_play(args):
    payload = {'zone_id': args.zone_id, 'query': args.query, 'action': args.action}
    if args.type:
        payload['type'] = args.type
    result = _post('/find-and-play', payload)
    print(json.dumps(result, indent=2))


def cmd_play_album(args):
    payload = {'zone_id': args.zone_id, 'query': args.query, 'action': args.action}
    result = _post('/play-album', payload)
    print(json.dumps(result, indent=2))


def cmd_shuffle(args):
    val = args.value.lower()
    if val not in ('true', 'false'):
        print("Error: value must be 'true' or 'false'", file=sys.stderr)
        sys.exit(1)
    payload = {'zone_id': args.zone_id, 'shuffle': val == 'true'}
    result = _post('/shuffle', payload)
    print(json.dumps(result, indent=2))


def cmd_playlist(args):
    payload = {
        'zone_id': args.zone_id,
        'tracks': [{'query': t} for t in args.tracks],
    }
    result = _post('/playlist', payload)
    print(json.dumps(result, indent=2))


# ── CLI ───────────────────────────────────────────────────────────────────────
p = argparse.ArgumentParser(description='Cowork Roon Controller')
sub = p.add_subparsers(dest='cmd', required=True)

sub.add_parser('status')
sub.add_parser('zones')

s = sub.add_parser('search')
s.add_argument('query')
s.add_argument('--type', choices=['tracks', 'albums', 'artists', 'composers'])

pl = sub.add_parser('play')
pl.add_argument('zone_id')
pl.add_argument('item_key')
pl.add_argument('--action', default='Play Now')

tr = sub.add_parser('transport')
tr.add_argument('zone_id')
tr.add_argument('action', choices=['play', 'pause', 'stop', 'next', 'previous', 'toggle_play_pause'])

vo = sub.add_parser('volume')
vo.add_argument('zone_id')
vo.add_argument('value', type=int)
vo.add_argument('--how', default='absolute', choices=['absolute', 'relative', 'relative_step'])

q = sub.add_parser('queue')
q.add_argument('zone_id')

br = sub.add_parser('browse')
br.add_argument('--item_key', default=None)

fap = sub.add_parser('find-and-play')
fap.add_argument('zone_id')
fap.add_argument('query')
fap.add_argument('--type', choices=['Tracks', 'Albums', 'Artists'])
fap.add_argument('--action', default='Play Now')

pa = sub.add_parser('play-album')
pa.add_argument('zone_id')
pa.add_argument('query')
pa.add_argument('--action', default='Play Now')

sh = sub.add_parser('shuffle')
sh.add_argument('zone_id')
sh.add_argument('value', metavar='true|false')

plist = sub.add_parser('playlist')
plist.add_argument('zone_id')
plist.add_argument('tracks', nargs='+', metavar='track')

CMDS = {
    'status':        cmd_status,
    'zones':         cmd_zones,
    'search':        cmd_search,
    'play':          cmd_play,
    'find-and-play': cmd_find_and_play,
    'play-album':    cmd_play_album,
    'shuffle':       cmd_shuffle,
    'playlist':      cmd_playlist,
    'transport':     cmd_transport,
    'volume':        cmd_volume,
    'queue':         cmd_queue,
    'browse':        cmd_browse,
}

args = p.parse_args()
CMDS[args.cmd](args)
