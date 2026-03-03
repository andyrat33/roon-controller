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
app.get('/api/search', (req, res) => {
  if (!requireCore(res)) return;
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const msKey = `search-${Date.now()}-${Math.random()}`;

  _browse.browse({ hierarchy: 'search', input: q, multi_session_key: msKey }, (err, r) => {
    if (err) return res.status(500).json({ error: String(err) });

    _browse.load({ hierarchy: 'search', multi_session_key: msKey, count: 100, offset: 0 }, (err, listR) => {
      if (err) return res.status(500).json({ error: String(err) });

      // listR.items = top-level categories (Artists, Albums, Tracks, …)
      const results = {};
      const pending = [];

      listR.items.forEach(cat => {
        // Optional type filter
        if (type && !cat.title.toLowerCase().includes(type.toLowerCase())) return;

        pending.push(new Promise(resolve => {
          const catKey = `${msKey}-${cat.title}`;
          _browse.browse({ hierarchy: 'search', item_key: cat.item_key, multi_session_key: catKey }, (err) => {
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
        }));
      });

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
  console.log(`   POST /api/volume     { zone_id, how, value }`);
  console.log(`   GET  /api/queue/:zone_id`);
  console.log('');
  console.log('🔍 Searching for Roon Core on the network...');
  console.log('   → Open Roon → Settings → Extensions → Enable "Cowork Controller"');
});

roon.start_discovery();
