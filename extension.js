'use strict';

const RoonApi          = require('node-roon-api');
const RoonApiBrowse    = require('node-roon-api-browse');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiStatus    = require('node-roon-api-status');
const express          = require('express');

const PORT = process.env.PORT || 3001;
const app  = express();
app.use(express.json());

// ─── State ────────────────────────────────────────────────────
let _core      = null;
let _browse    = null;
let _transport = null;
let _status    = null;
let _zones     = {};   // zone_id → zone object (kept live via subscription)

// ─── Roon Setup ───────────────────────────────────────────────
const roon = new RoonApi({
  extension_id:    'com.cowork.roon-controller',
  display_name:    'Cowork Controller',
  display_version: '1.0.0',
  publisher:       'Andy Ratcliffe',
  email:           'andrew.ratcliffe@nswcsystems.co.uk',
  website:         'https://claude.ai',

  core_paired: (core) => {
    _core      = core;
    _browse    = core.services.RoonApiBrowse;
    _transport = core.services.RoonApiTransport;
    _status.set_status('Connected to ' + core.display_name, false);

    // Keep zones map live
    _transport.subscribe_zones((cmd, data) => {
      if (cmd === 'Subscribed') {
        (data.zones || []).forEach(z => _zones[z.zone_id] = z);
      } else if (cmd === 'Changed') {
        (data.zones_changed  || []).forEach(z => _zones[z.zone_id] = z);
        (data.zones_added    || []).forEach(z => _zones[z.zone_id] = z);
        (data.zones_removed  || []).forEach(id => delete _zones[id]);
      }
    });

    console.log('✅ Paired with Roon Core:', core.display_name);
  },

  core_unpaired: (core) => {
    _core = null; _browse = null; _transport = null; _zones = {};
    _status.set_status('Waiting for Roon Core...', false);
    console.log('❌ Unpaired from Roon Core');
  }
});

_status = new RoonApiStatus(roon);

roon.init_services({
  required_services: [RoonApiBrowse, RoonApiTransport],
  provided_services: [_status]
});

// ─── Helpers ─────────────────────────────────────────────────
function requireCore(res) {
  if (!_core) {
    res.status(503).json({ error: 'Not connected to Roon Core — please authorise the extension in Roon Settings → Extensions' });
    return false;
  }
  return true;
}

function zoneInfo(z) {
  return {
    zone_id:      z.zone_id,
    display_name: z.display_name,
    state:        z.state,
    outputs:      (z.outputs || []).map(o => ({
      output_id:    o.output_id,
      display_name: o.display_name,
      volume:       o.volume ? { value: o.volume.value, min: o.volume.min, max: o.volume.max, type: o.volume.type } : null
    })),
    now_playing: z.now_playing ? {
      title:         z.now_playing.three_line?.line1 || '',
      artist:        z.now_playing.three_line?.line2 || '',
      album:         z.now_playing.three_line?.line3 || '',
      seek_position: z.now_playing.seek_position,
      length:        z.now_playing.length,
      image_key:     z.now_playing.image_key
    } : null
  };
}

function pickBestMatch(items, index, artist) {
  if (!items || items.length === 0) return undefined;
  if (artist) {
    const needle = artist.toLowerCase();
    const match = items.find(i => (i.subtitle || '').toLowerCase().includes(needle));
    if (match) return match;
  }
  return items[Math.min(index, items.length - 1)];
}

// ─── REST API ─────────────────────────────────────────────────

// GET /api/status  — health check + current playback across all zones
app.get('/api/status', (req, res) => {
  if (!_core) return res.json({ connected: false, message: 'Waiting for Roon Core' });
  res.json({
    connected:  true,
    core_name:  _core.display_name,
    core_id:    _core.core_id,
    zones:      Object.values(_zones).map(zoneInfo)
  });
});

// GET /api/zones  — list all zones
app.get('/api/zones', (req, res) => {
  if (!requireCore(res)) return;
  res.json(Object.values(_zones).map(zoneInfo));
});

// ─── Search ───────────────────────────────────────────────────
// GET /api/search?q=<query>[&type=tracks|albums|artists|composers]
// Each category gets its own fresh session so item_keys stay valid.
app.get('/api/search', (req, res) => {
  if (!requireCore(res)) return;
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing ?q= parameter' });

  // Step 1: one session just to discover which categories exist
  const discoverKey = `search-discover-${Date.now()}-${Math.random()}`;
  _browse.browse({ hierarchy: 'search', input: q, multi_session_key: discoverKey }, (err) => {
    if (err) return res.status(500).json({ error: String(err) });

    _browse.load({ hierarchy: 'search', multi_session_key: discoverKey, count: 100, offset: 0 }, (err, listR) => {
      if (err) return res.status(500).json({ error: String(err) });

      const categories = (listR.items || []).filter(cat => {
        if (type && !cat.title.toLowerCase().includes(type.toLowerCase())) return false;
        return true;
      });

      if (categories.length === 0) return res.json({});

      // Step 2: for each category, open a fresh session, re-search, navigate into that category
      const results = {};
      const pending = categories.map(cat => new Promise(resolve => {
        const catKey = `search-${cat.title}-${Date.now()}-${Math.random()}`;

        _browse.browse({ hierarchy: 'search', input: q, multi_session_key: catKey }, (err) => {
          if (err) return resolve();
          _browse.load({ hierarchy: 'search', multi_session_key: catKey, count: 100, offset: 0 }, (err, freshR) => {
            if (err) return resolve();

            // Find same category by title in this fresh session
            const freshCat = (freshR.items || []).find(i => i.title === cat.title);
            if (!freshCat) return resolve();

            // Navigate into it — item_key is now valid for this session
            _browse.browse({ hierarchy: 'search', item_key: freshCat.item_key, multi_session_key: catKey }, (err) => {
              if (err) return resolve();
              _browse.load({ hierarchy: 'search', multi_session_key: catKey, count: 50, offset: 0 }, (err, catR) => {
                if (err) return resolve();
                results[cat.title] = (catR.items || []).map(i => ({
                  title:    i.title,
                  subtitle: i.subtitle,
                  item_key: i.item_key,
                  hint:     i.hint
                }));
                resolve();
              });
            });
          });
        });
      }));

      Promise.all(pending).then(() => res.json(results));
    });
  });
});

// ─── Browse ───────────────────────────────────────────────────
// GET /api/browse[?item_key=<key>][&count=100][&offset=0]
// Navigate the library hierarchy. Omit item_key to start at the root.
app.get('/api/browse', (req, res) => {
  if (!requireCore(res)) return;
  const { item_key, count = 100, offset = 0 } = req.query;

  const msKey = `browse-${Date.now()}-${Math.random()}`;
  const opts  = { hierarchy: 'browse', multi_session_key: msKey };
  if (item_key) opts.item_key = item_key;

  _browse.browse(opts, (err, browseR) => {
    if (err) return res.status(500).json({ error: String(err) });

    _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: parseInt(count), offset: parseInt(offset) }, (err, loadR) => {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({
        title:  browseR.list?.title || '',
        total:  loadR.list?.count  || 0,
        offset: loadR.list?.offset || 0,
        items:  (loadR.items || []).map(i => ({
          title:    i.title,
          subtitle: i.subtitle,
          item_key: i.item_key,
          hint:     i.hint          // 'action_list' | 'list' | 'header' etc.
        }))
      });
    });
  });
});

// ─── TIDAL Search ─────────────────────────────────────────────
// GET /api/tidal/search?q=<query>
// Navigates Root → TIDAL → Search within a single session so item_keys carry over
app.get('/api/tidal/search', (req, res) => {
  if (!requireCore(res)) return;
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const msKey = `tidal-${Date.now()}-${Math.random()}`;

  // Helper: browse then immediately load, reusing same session
  function nav(browseOpts, loadCount, cb) {
    _browse.browse({ ...browseOpts, multi_session_key: msKey }, (err, bR) => {
      if (err) return cb(err);
      _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: loadCount, offset: 0 }, (err, lR) => {
        if (err) return cb(err);
        cb(null, bR, lR);
      });
    });
  }

  // Step 1: Root
  nav({ hierarchy: 'browse' }, 20, (err, _, rootR) => {
    if (err) return res.status(500).json({ error: String(err) });

    const tidalItem = (rootR.items || []).find(i => i.title === 'TIDAL');
    if (!tidalItem) return res.status(404).json({ error: 'TIDAL not found — is it connected in Roon?' });

    // Step 2: TIDAL home
    nav({ hierarchy: 'browse', item_key: tidalItem.item_key }, 20, (err, _, tidalR) => {
      if (err) return res.status(500).json({ error: String(err) });

      const searchItem = (tidalR.items || []).find(i =>
        i.title.toLowerCase() === 'search' || i.hint === 'action'
      );
      if (!searchItem) return res.json({ debug: 'No search entry in TIDAL, items found:', items: tidalR.items });

      // Step 3: Search with input
      nav({ hierarchy: 'browse', item_key: searchItem.item_key, input: q }, 50, (err, searchBR, searchR) => {
        if (err) return res.status(500).json({ error: String(err) });

        // Results may be categories (Artists, Albums, Tracks…) — load each one
        const categories = (searchR.items || []).filter(i => i.hint === 'list');
        if (categories.length === 0) {
          return res.json({ query: q, results: {}, raw: searchR.items });
        }

        const results = {};
        let pending = categories.length;

        categories.forEach(cat => {
          const catMsKey = `${msKey}-${cat.title}`;
          _browse.browse({ hierarchy: 'browse', item_key: cat.item_key, multi_session_key: catMsKey }, (err) => {
            if (err) { if (--pending === 0) res.json({ query: q, results }); return; }
            _browse.load({ hierarchy: 'browse', multi_session_key: catMsKey, count: 30, offset: 0 }, (err, catR) => {
              if (!err) {
                results[cat.title] = (catR.items || []).map(i => ({
                  title: i.title, subtitle: i.subtitle, item_key: i.item_key, hint: i.hint
                }));
              }
              if (--pending === 0) res.json({ query: q, results });
            });
          });
        });
      });
    });
  });
});

// ─── Inspect Track Actions ────────────────────────────────────
// GET /api/inspect?q=<query>  — returns every action Roon offers for the first result
app.get('/api/inspect', (req, res) => {
  if (!requireCore(res)) return;
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  const msKey = `inspect-${Date.now()}-${Math.random()}`;
  const log = [];

  _browse.browse({ hierarchy: 'search', input: q, multi_session_key: msKey }, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 100 }, (err, topR) => {
      if (err) return res.status(500).json({ error: String(err) });

      const tracksCat = (topR.items || []).find(i => i.title === 'Tracks');
      if (!tracksCat) return res.json({ error: 'No Tracks category', top: topR.items.map(i=>i.title) });

      log.push({ step: 'top categories', items: topR.items.map(i=>i.title) });

      _browse.browse({ hierarchy: 'search', item_key: tracksCat.item_key, multi_session_key: msKey }, (err) => {
        if (err) return res.status(500).json({ error: String(err) });
        _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 10 }, (err, tracksR) => {
          if (err) return res.status(500).json({ error: String(err) });

          const first = (tracksR.items || [])[0];
          log.push({ step: 'tracks list', items: tracksR.items.map(i=>({ title:i.title, hint:i.hint })) });
          if (!first) return res.json({ log });

          _browse.browse({ hierarchy: 'search', item_key: first.item_key, zone_or_output_id: Object.keys(_zones)[0], multi_session_key: msKey }, (err, r1) => {
            if (err) return res.status(500).json({ error: String(err) });
            log.push({ step: 'browse track', action: r1.action });

            _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 10 }, (err, level1) => {
              if (err) return res.status(500).json({ error: String(err) });
              log.push({ step: 'level 1 items', items: level1.items.map(i=>({ title:i.title, hint:i.hint, item_key:i.item_key })) });

              // Go one level deeper into first item
              const next = (level1.items || [])[0];
              if (!next) return res.json({ log });

              _browse.browse({ hierarchy: 'search', item_key: next.item_key, zone_or_output_id: Object.keys(_zones)[0], multi_session_key: msKey }, (err, r2) => {
                if (err) return res.status(500).json({ error: String(err) });
                log.push({ step: 'browse level1[0]', action: r2.action });

                _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 15 }, (err, level2) => {
                  if (err) return res.status(500).json({ error: String(err) });
                  log.push({ step: 'level 2 items', items: level2.items.map(i=>({ title:i.title, hint:i.hint })) });
                  res.json({ log });
                });
              });
            });
          });
        });
      });
    });
  });
});

// ─── Find and Play ────────────────────────────────────────────
// POST /api/find-and-play  { zone_id, query, type?: "Tracks"|"Albums"|"Artists", index?: 0, action?: "Play Now" }
// Searches and plays in a single session so item_keys stay valid throughout.
app.post('/api/find-and-play', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, query, type = 'Tracks', index = 0, action = 'Play Now', artist } = req.body;
  if (!zone_id || !query) return res.status(400).json({ error: 'zone_id and query are required' });

  // Normalise action aliases to match Roon's actual labels
  const ACTION_MAP = { 'Add to Queue': 'Queue', 'Play Next': 'Add Next', 'Add to queue': 'Queue' };
  const roonAction = ACTION_MAP[action] || action;

  const msKey = `fap-${Date.now()}-${Math.random()}`;

  // Step 1: Search
  _browse.browse({ hierarchy: 'search', input: query, multi_session_key: msKey }, (err) => {
    if (err) return res.status(500).json({ error: String(err) });

    _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 100, offset: 0 }, (err, topR) => {
      if (err) return res.status(500).json({ error: String(err) });

      // Step 2: Find the requested category (Tracks, Albums, Artists…)
      const cat = (topR.items || []).find(i => i.title === type);
      if (!cat) return res.status(404).json({ error: `Category "${type}" not found in results`, available: topR.items.map(i => i.title) });

      _browse.browse({ hierarchy: 'search', item_key: cat.item_key, multi_session_key: msKey }, (err) => {
        if (err) return res.status(500).json({ error: String(err) });

        _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 50, offset: 0 }, (err, catR) => {
          if (err) return res.status(500).json({ error: String(err) });

          const items = catR.items || [];
          if (items.length === 0) return res.status(404).json({ error: `No results for "${query}" in ${type}` });

          const target = pickBestMatch(items, index, artist);

          // Step 3: Navigate to item to get action list
          _browse.browse({ hierarchy: 'search', item_key: target.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, r) => {
            if (err) return res.status(500).json({ error: String(err) });

            if (r.action !== 'list') {
              return res.json({ success: true, playing: target.title, action: r.action });
            }

            _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 10, offset: 0 }, (err, actionR) => {
              if (err) return res.status(500).json({ error: String(err) });

              // Check if this is already an action list or an intermediate container
              const directAction = (actionR.items || []).find(i => i.title === roonAction);
              const isIntermediate = !directAction && actionR.items.length > 0 && actionR.items[0].hint === 'action_list';

              if (isIntermediate) {
                // Navigate into the container (e.g. the track title) to reach the real action list
                const intermediate = actionR.items[0];
                _browse.browse({ hierarchy: 'search', item_key: intermediate.item_key, multi_session_key: msKey }, (err, r2) => {
                  if (err) return res.status(500).json({ error: String(err) });
                  if (r2.action !== 'list') return res.json({ success: true, playing: `${target.title} — ${target.subtitle}`, action: r2.action });

                  _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 15, offset: 0 }, (err, actionR2) => {
                    if (err) return res.status(500).json({ error: String(err) });

                    const pa2 = (actionR2.items || []).find(i => i.title === roonAction)
                             || (roonAction === 'Play Now' ? (actionR2.items || []).find(i => i.title === 'Play Now') : null);
                    if (!pa2) return res.status(404).json({ error: `Action "${roonAction}" not found`, available: actionR2.items.map(i => i.title) });

                    _browse.browse({ hierarchy: 'search', item_key: pa2.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, playR) => {
                      if (err) return res.status(500).json({ error: String(err) });
                      res.json({ success: true, playing: `${target.title} — ${target.subtitle}`, action: playR.action });
                    });
                  });
                });
                return;
              }

              if (!directAction) return res.status(404).json({ error: `Action "${roonAction}" not found`, available: (actionR.items||[]).map(i => i.title) });

              _browse.browse({ hierarchy: 'search', item_key: directAction.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, playR) => {
                if (err) return res.status(500).json({ error: String(err) });
                res.json({ success: true, playing: `${target.title} — ${target.subtitle}`, action: playR.action });
              });
            });
          });
        });
      });
    });
  });
});

// ─── Play ─────────────────────────────────────────────────────
// POST /api/play  { zone_id, item_key, action?: "Play Now"|"Play Next"|"Add to Queue"|"Start Radio" }
app.post('/api/play', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, item_key, action = 'Play Now' } = req.body;
  if (!zone_id || !item_key) return res.status(400).json({ error: 'zone_id and item_key are required' });

  const msKey = `play-${Date.now()}-${Math.random()}`;

  _browse.browse({ hierarchy: 'browse', item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, r) => {
    if (err) return res.status(500).json({ error: String(err) });

    if (r.action === 'list') {
      // An action list was returned — find the requested action
      _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: 10, offset: 0 }, (err, listR) => {
        if (err) return res.status(500).json({ error: String(err) });

        const target = listR.items.find(i => i.title === action)
                    || listR.items.find(i => i.title === 'Play Now'); // fallback

        if (!target) {
          return res.status(404).json({
            error: `Action "${action}" not found`,
            available: listR.items.map(i => i.title)
          });
        }

        _browse.browse({ hierarchy: 'browse', item_key: target.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, playR) => {
          if (err) return res.status(500).json({ error: String(err) });
          res.json({ success: true, action: playR.action });
        });
      });

    } else {
      // Directly acted (e.g. some items auto-play)
      res.json({ success: true, action: r.action });
    }
  });
});

// ─── Profile list ─────────────────────────────────────────────
// GET /api/profiles
// Returns the list of Roon profiles and which one is currently active.
// NOTE: The Roon Extension API does not support switching profiles — profiles
// are per-Roon-Remote (app) and cannot be changed by a third-party extension.
app.get('/api/profiles', (req, res) => {
  if (!requireCore(res)) return;
  const msKey = `profiles-${Date.now()}-${Math.random()}`;

  function nav(browseOpts, cb) {
    _browse.browse({ ...browseOpts, hierarchy: 'browse', multi_session_key: msKey }, (err, bR) => {
      if (err) return cb(err);
      _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: 50, offset: 0 }, (err, lR) => {
        if (err) return cb(err);
        cb(null, lR.items || []);
      });
    });
  }

  nav({}, (err, rootItems) => {
    if (err) return res.status(500).json({ error: String(err) });
    const settings = rootItems.find(i => i.title === 'Settings');
    if (!settings) return res.status(404).json({ error: 'Settings menu not found' });

    nav({ item_key: settings.item_key }, (err, settingsItems) => {
      if (err) return res.status(500).json({ error: String(err) });
      const profileMenu = settingsItems.find(i => /profile/i.test(i.title));
      if (!profileMenu) return res.status(404).json({ error: 'Profile menu not found in Settings' });

      nav({ item_key: profileMenu.item_key }, (err, profileItems) => {
        if (err) return res.status(500).json({ error: String(err) });
        const profiles = profileItems.map(i => ({ name: i.title, active: i.subtitle === 'selected' }));
        res.json({ profiles });
      });
    });
  });
});

// ─── Transport ────────────────────────────────────────────────
// POST /api/transport  { zone_id, action: play|pause|stop|next|previous|toggle_play_pause }
app.post('/api/transport', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, action } = req.body;

  const valid = ['play', 'pause', 'stop', 'next', 'previous', 'toggle_play_pause'];
  if (!valid.includes(action)) return res.status(400).json({ error: `action must be one of: ${valid.join(', ')}` });

  _transport.control(zone_id, action, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});


// ─── Shuffle ──────────────────────────────────────────────────
// POST /api/shuffle  { zone_id, shuffle: true|false }
app.post('/api/shuffle', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, shuffle } = req.body;
  if (shuffle === undefined) return res.status(400).json({ error: 'shuffle (boolean) is required' });
  _transport.change_settings(zone_id, { shuffle: !!shuffle }, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true, shuffle: !!shuffle });
  });
});

// ─── Mute ─────────────────────────────────────────────────────
// POST /api/mute  { zone_id, mute: true|false }
app.post('/api/mute', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, mute } = req.body;
  if (mute === undefined) return res.status(400).json({ error: 'mute (boolean) is required' });
  const zone = _zones[zone_id];
  const output = zone?.outputs?.[0];
  if (!output) return res.status(404).json({ error: 'Zone or output not found' });
  _transport.mute(output, mute ? 'mute' : 'unmute', (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true, muted: !!mute });
  });
});

// POST /api/mute/all  { mute: true|false }
app.post('/api/mute/all', (req, res) => {
  if (!requireCore(res)) return;
  const { mute } = req.body;
  if (mute === undefined) return res.status(400).json({ error: 'mute (boolean) is required' });
  _transport.mute_all(mute ? 'mute' : 'unmute', (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true, muted: !!mute });
  });
});

// ─── Pause All ────────────────────────────────────────────────
// POST /api/pause/all
app.post('/api/pause/all', (req, res) => {
  if (!requireCore(res)) return;
  _transport.pause_all((err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Standby ──────────────────────────────────────────────────
// POST /api/standby  { zone_id }  — toggles standby on the zone's output
app.post('/api/standby', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id } = req.body;
  if (!zone_id) return res.status(400).json({ error: 'zone_id is required' });
  const zone = _zones[zone_id];
  const output = zone?.outputs?.[0];
  if (!output) return res.status(404).json({ error: 'Zone or output not found' });
  _transport.toggle_standby(output, {}, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Group / Ungroup ──────────────────────────────────────────
// POST /api/group    { zone_ids: ["id1", "id2", ...] }  — sync outputs together
// POST /api/ungroup  { zone_ids: ["id1", ...] }          — remove outputs from group
app.post('/api/group', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_ids } = req.body;
  if (!Array.isArray(zone_ids) || zone_ids.length < 2)
    return res.status(400).json({ error: 'zone_ids must be an array of at least 2 zone IDs' });
  const outputs = zone_ids.map(id => _zones[id]?.outputs?.[0]).filter(Boolean);
  if (outputs.length < 2) return res.status(404).json({ error: 'Fewer than 2 valid zones found' });
  _transport.group_outputs(outputs, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

app.post('/api/ungroup', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_ids } = req.body;
  if (!Array.isArray(zone_ids) || zone_ids.length === 0)
    return res.status(400).json({ error: 'zone_ids must be a non-empty array' });
  const outputs = zone_ids.map(id => _zones[id]?.outputs?.[0]).filter(Boolean);
  if (!outputs.length) return res.status(404).json({ error: 'No valid zones found' });
  _transport.ungroup_outputs(outputs, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Transfer Zone ────────────────────────────────────────────
// POST /api/transfer  { from_zone_id, to_zone_id }
// Moves the current queue from one zone to another.
app.post('/api/transfer', (req, res) => {
  if (!requireCore(res)) return;
  const { from_zone_id, to_zone_id } = req.body;
  if (!from_zone_id || !to_zone_id) return res.status(400).json({ error: 'from_zone_id and to_zone_id are required' });
  const fromZone = _zones[from_zone_id];
  const toZone   = _zones[to_zone_id];
  if (!fromZone) return res.status(404).json({ error: `from_zone_id not found: ${from_zone_id}` });
  if (!toZone)   return res.status(404).json({ error: `to_zone_id not found: ${to_zone_id}` });
  _transport.transfer_zone(fromZone, toZone, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Volume ───────────────────────────────────────────────────
// POST /api/volume  { zone_id, how: "absolute"|"relative"|"relative_step", value: number }
app.post('/api/volume', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, how = 'absolute', value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value is required' });

  const zone = _zones[zone_id];
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const output = (zone.outputs || [])[0];
  if (!output) return res.status(404).json({ error: 'No output found for zone' });

  _transport.change_volume(output.output_id, how, value, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Seek ─────────────────────────────────────────────────────
// POST /api/seek  { zone_id, how: "absolute"|"relative", seconds: number }
app.post('/api/seek', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, how = 'absolute', seconds } = req.body;

  _transport.seek(zone_id, how, seconds, (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ success: true });
  });
});

// ─── Queue ────────────────────────────────────────────────────
// GET /api/queue/:zone_id
app.get('/api/queue/:zone_id', (req, res) => {
  if (!requireCore(res)) return;
  _transport.get_queue(req.params.zone_id, 100, (err, queue) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(queue || []);
  });
});

// POST /api/queue/clear  { zone_id }
// Navigates the Roon browse hierarchy to find and execute the "Clear Queue" action.
app.post('/api/queue/clear', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id } = req.body;
  if (!zone_id) return res.status(400).json({ error: 'zone_id is required' });

  const msKey = `qclear-${Date.now()}-${Math.random()}`;
  const log = [];

  _browse.browse({ hierarchy: 'browse', zone_or_output_id: zone_id, multi_session_key: msKey }, (err) => {
    if (err) return res.status(500).json({ error: String(err) });

    _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: 100, offset: 0 }, (err, rootR) => {
      if (err) return res.status(500).json({ error: String(err) });

      const rootItems = rootR.items || [];
      log.push({ step: 'root', items: rootItems.map(i => ({ title: i.title, hint: i.hint })) });

      const queueItem = rootItems.find(i => /queue/i.test(i.title));
      if (!queueItem) {
        return res.status(404).json({ error: 'Queue not found in root browse', log });
      }

      _browse.browse({ hierarchy: 'browse', item_key: queueItem.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err) => {
        if (err) return res.status(500).json({ error: String(err), log });

        _browse.load({ hierarchy: 'browse', multi_session_key: msKey, count: 50, offset: 0 }, (err, qR) => {
          if (err) return res.status(500).json({ error: String(err), log });

          const qItems = qR.items || [];
          log.push({ step: 'queue section', items: qItems.map(i => ({ title: i.title, hint: i.hint })) });

          const clearItem = qItems.find(i => /clear/i.test(i.title));
          if (!clearItem) {
            return res.status(404).json({ error: 'Clear Queue action not found', log });
          }

          _browse.browse({ hierarchy: 'browse', item_key: clearItem.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, clearR) => {
            if (err) return res.status(500).json({ error: String(err), log });
            res.json({ success: true, action: clearR.action });
          });
        });
      });
    });
  });
});

// ─── Playlist (Queue Builder) ──────────────────────────────────
// POST /api/playlist
// { name: "My Playlist", zone_id: "...", tracks: [{query, type?}] }
//
// NOTE: Roon's Extension API does not expose playlist management actions
// (Add to Playlist, Create Playlist) — only playback actions are available
// to third-party extensions. This endpoint instead builds the playlist as
// a Roon queue, which you can then save as a named playlist from within the
// Roon app: Queue → ⋮ → Save Queue as Playlist.
//
// The first track uses "Play Now" (starts playback, clears existing queue).
// All subsequent tracks use "Queue" (appended in order).
// Tracks are processed sequentially with a 2-second delay between calls.
app.post('/api/playlist', async (req, res) => {
  if (!requireCore(res)) return;
  const { name, zone_id, tracks } = req.body;
  if (!zone_id)                                 return res.status(400).json({ error: 'zone_id is required' });
  if (!Array.isArray(tracks) || !tracks.length) return res.status(400).json({ error: 'tracks[] is required' });

  const results      = [];
  const ACTION_MAP   = { 'Add to Queue': 'Queue', 'Play Next': 'Add Next', 'Add to queue': 'Queue' };

  for (let i = 0; i < tracks.length; i++) {
    const { query, type = 'Tracks', artist } = tracks[i];
    if (!query) { results.push({ query, status: 'skipped', reason: 'missing query' }); continue; }

    const action    = i === 0 ? 'Play Now' : 'Queue';
    const roonAction = ACTION_MAP[action] || action;
    const msKey     = `pl-${Date.now()}-${Math.random()}`;

    await new Promise(resolve => {
      _browse.browse({ hierarchy: 'search', input: query, multi_session_key: msKey }, (err) => {
        if (err) { results.push({ query, status: 'error', reason: String(err) }); return resolve(); }

        _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 100, offset: 0 }, (err, topR) => {
          if (err) { results.push({ query, status: 'error', reason: String(err) }); return resolve(); }

          const cat = (topR.items || []).find(it => it.title === type);
          if (!cat) { results.push({ query, status: 'error', reason: `Category "${type}" not found` }); return resolve(); }

          _browse.browse({ hierarchy: 'search', item_key: cat.item_key, multi_session_key: msKey }, (err) => {
            if (err) { results.push({ query, status: 'error', reason: String(err) }); return resolve(); }

            _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 50, offset: 0 }, (err, catR) => {
              if (err) { results.push({ query, status: 'error', reason: String(err) }); return resolve(); }

              const catItems = catR.items || [];
              const target = pickBestMatch(catItems, 0, artist);
              if (!target) { results.push({ query, status: 'not_found' }); return resolve(); }

              const trackLabel = `${target.title} — ${target.subtitle}`;

              _browse.browse({ hierarchy: 'search', item_key: target.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, r) => {
                if (err) { results.push({ query, track: trackLabel, status: 'error', reason: String(err) }); return resolve(); }
                if (r.action !== 'list') { results.push({ query, track: trackLabel, status: 'queued', action: r.action }); return resolve(); }

                _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 10, offset: 0 }, (err, actionR) => {
                  if (err) { results.push({ query, track: trackLabel, status: 'error', reason: String(err) }); return resolve(); }

                  const directAction = (actionR.items || []).find(it => it.title === roonAction);
                  const isIntermediate = !directAction && (actionR.items||[]).length > 0 && actionR.items[0].hint === 'action_list';

                  const execAction = (actionItem) => {
                    _browse.browse({ hierarchy: 'search', item_key: actionItem.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, playR) => {
                      if (err) { results.push({ query, track: trackLabel, status: 'error', reason: String(err) }); return resolve(); }
                      results.push({ query, track: trackLabel, status: 'queued', action: roonAction, roon_action: playR.action });
                      resolve();
                    });
                  };

                  if (directAction) return execAction(directAction);

                  if (isIntermediate) {
                    const mid = actionR.items[0];
                    _browse.browse({ hierarchy: 'search', item_key: mid.item_key, multi_session_key: msKey }, (err) => {
                      if (err) { results.push({ query, track: trackLabel, status: 'error', reason: String(err) }); return resolve(); }
                      _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 15, offset: 0 }, (err, actionR2) => {
                        if (err) { results.push({ query, track: trackLabel, status: 'error', reason: String(err) }); return resolve(); }
                        const pa2 = (actionR2.items || []).find(it => it.title === roonAction);
                        if (!pa2) { results.push({ query, track: trackLabel, status: 'error', reason: `Action "${roonAction}" not found`, available: actionR2.items.map(it=>it.title) }); return resolve(); }
                        execAction(pa2);
                      });
                    });
                    return;
                  }

                  results.push({ query, track: trackLabel, status: 'error', reason: `Action "${roonAction}" not found`, available: (actionR.items||[]).map(it=>it.title) });
                  resolve();
                });
              });
            });
          });
        });
      });
    });

    if (i < tracks.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  const queued = results.filter(r => r.status === 'queued').length;
  res.json({
    name,
    note: 'Tracks queued successfully. To save as a Roon playlist: Queue → ⋮ → Save Queue as Playlist.',
    queued,
    total: tracks.length,
    results
  });
});

// ─── Play Album ──────────────────────────────────────────────
// POST /api/play-album  { zone_id, query, action?: "Play Now"|"Queue"|"Add Next"|"Start Radio" }
// Searches for an album, navigates the full Roon browse hierarchy,
// and triggers the album-level action (which queues all tracks natively).
app.post('/api/play-album', (req, res) => {
  if (!requireCore(res)) return;
  const { zone_id, query, action = 'Play Now' } = req.body;
  if (!zone_id || !query) return res.status(400).json({ error: 'zone_id and query are required' });

  const ACTION_MAP = { 'Add to Queue': 'Queue', 'Play Next': 'Add Next', 'Add to queue': 'Queue' };
  const roonAction = ACTION_MAP[action] || action;
  const msKey = `album-${Date.now()}-${Math.random()}`;
  const log = [];

  // Helper: browse then load within the same session
  function navAndLoad(browseOpts, loadCount, cb) {
    _browse.browse({ ...browseOpts, hierarchy: 'search', multi_session_key: msKey }, (err, bR) => {
      if (err) return cb(err);
      _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: loadCount, offset: 0 }, (err, lR) => {
        if (err) return cb(err);
        cb(null, bR, lR);
      });
    });
  }

  // Step 1: Search
  navAndLoad({ input: query }, 100, (err, _, topR) => {
    if (err) return res.status(500).json({ error: String(err) });

    const topItems = topR.items || [];
    log.push({ step: 'search', categories: topItems.map(i => i.title) });

    // Step 2: Find Albums category
    const albumsCat = topItems.find(i => i.title === 'Albums');
    if (!albumsCat) return res.status(404).json({ error: 'No "Albums" category in results', log });

    navAndLoad({ item_key: albumsCat.item_key }, 50, (err, _, albumsR) => {
      if (err) return res.status(500).json({ error: String(err) });

      const albums = albumsR.items || [];
      log.push({ step: 'albums list', items: albums.map(i => ({ title: i.title, subtitle: i.subtitle, hint: i.hint })) });
      if (albums.length === 0) return res.status(404).json({ error: 'No albums found', log });

      const target = albums[0];

      // Step 3: Browse into the album — this starts a deeper navigation
      // We recursively navigate until we find action items (Play Now, Queue, etc.)
      function findAndExecuteAction(itemKey, depth) {
        if (depth > 5) return res.status(500).json({ error: 'Too many navigation levels', log });

        _browse.browse({ hierarchy: 'search', item_key: itemKey, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, bR) => {
          if (err) return res.status(500).json({ error: String(err), log });

          log.push({ step: `browse depth ${depth}`, action: bR.action });

          // If the browse itself triggered playback, we're done
          if (bR.action && bR.action !== 'list') {
            return res.json({ success: true, album: target.title, artist: target.subtitle, action: bR.action, log });
          }

          _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 50, offset: 0 }, (err, loadR) => {
            if (err) return res.status(500).json({ error: String(err), log });

            const items = loadR.items || [];
            log.push({ step: `items depth ${depth}`, items: items.map(i => ({ title: i.title, hint: i.hint })) });

            // Look for the requested action (e.g. "Play Now") among the items
            const actionItem = items.find(i => i.hint === 'action' && i.title === roonAction);
            if (actionItem) {
              // Found the action — execute it
              _browse.browse({ hierarchy: 'search', item_key: actionItem.item_key, zone_or_output_id: zone_id, multi_session_key: msKey }, (err, playR) => {
                if (err) return res.status(500).json({ error: String(err), log });
                return res.json({ success: true, album: target.title, artist: target.subtitle, action: playR.action, log });
              });
              return;
            }

            // Look for any action items at this level
            const anyAction = items.find(i => i.hint === 'action');
            if (anyAction) {
              // There are actions but not the one we want
              return res.status(404).json({
                error: `Action "${roonAction}" not found at album level`,
                available: items.filter(i => i.hint === 'action').map(i => i.title),
                log
              });
            }

            // No actions found yet — navigate into the first non-header item to go deeper
            const nextItem = items.find(i => i.hint !== 'header');
            if (!nextItem) return res.status(404).json({ error: 'No navigable items found', log });

            findAndExecuteAction(nextItem.item_key, depth + 1);
          });
        });
      }

      findAndExecuteAction(target.item_key, 0);
    });
  });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🎵 Cowork Roon Controller');
  console.log(`   REST API → http://0.0.0.0:${PORT}`);
  console.log('');
  console.log('   Endpoints:');
  console.log(`   GET  /api/status`);
  console.log(`   GET  /api/zones`);
  console.log(`   GET  /api/search?q=<query>[&type=tracks|albums|artists]`);
  console.log(`   GET  /api/browse[?item_key=<key>]`);
  console.log(`   POST /api/play       { zone_id, item_key, action? }`);
  console.log(`   POST /api/transport  { zone_id, action }`);
  console.log(`   POST /api/mute       { zone_id, mute: true|false }`);
  console.log(`   POST /api/mute/all   { mute: true|false }`);
  console.log(`   POST /api/pause/all`);
  console.log(`   POST /api/standby    { zone_id }`);
  console.log(`   POST /api/group      { zone_ids: [...] }`);
  console.log(`   POST /api/ungroup    { zone_ids: [...] }`);
  console.log(`   POST /api/transfer   { from_zone_id, to_zone_id }`);
  console.log(`   POST /api/volume     { zone_id, how, value }`);
  console.log(`   GET  /api/queue/:zone_id`);
  console.log(`   POST /api/queue/clear    { zone_id }`);
  console.log(`   POST /api/playlist   { name, tracks:[{query,type?}], create? }`);
  console.log(`   POST /api/play-album { zone_id, query, action? }`);
  console.log(`   GET  /api/profiles  (read-only — profile switching not supported by Extension API)`);
  console.log('');
  console.log('🔍 Searching for Roon Core on the network...');
  console.log('   → Open Roon → Settings → Extensions → Enable "Cowork Controller"');
});

roon.start_discovery();
