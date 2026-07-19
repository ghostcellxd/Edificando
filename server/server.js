'use strict';
/*
 * Edificando Sobre La Roca — backend
 * - Viewers POST comments; they are relayed live ONLY to authenticated streamers.
 * - Recordings archive is public and never carries comments.
 *
 * Env vars:
 *   PORT           default 3000
 *   SECRET_KEY     the streamer key that unlocks the live comment feed  (required)
 *   RECORDINGS_DIR folder of finished .mp4/.m3u8 recordings              (default ./recordings)
 *   PUBLIC_BASE    public URL where recordings are served, e.g. https://host/vod
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'cambia-esta-clave';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '/vod').replace(/\/+$/, '');
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || path.join(__dirname, 'schedule.json');

// streamer sockets grouped by stream code
const streamers = new Map(); // code -> Set<ws>

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

function loadSchedule() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) || []; }
  catch { return []; }
}

// Match a recording to its scheduled service and borrow that title.
// Recording basenames look like: <code>-YYYY-MM-DD-HHMM
function parseRecBase(base) {
  const m = base.match(/^(.*?)-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, code, Y, Mo, D, H, Mi] = m;
  const dt = new Date(+Y, +Mo - 1, +D, +H, +Mi);
  return { code, dt, weekday: dt.getDay(), minutes: +H * 60 + +Mi };
}
function scheduleTitleFor(base, schedule) {
  const p = parseRecBase(base);
  if (!p || !schedule.length) return null;
  // same stream code + same weekday, then the entry with the closest start time
  const candidates = schedule.filter(e =>
    (!e.code || e.code === p.code) && Number(e.day) === p.weekday);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const am = timeToMin(a.time), bm = timeToMin(b.time);
    return Math.abs(am - p.minutes) - Math.abs(bm - p.minutes);
  });
  return candidates[0].title || null;
}
function timeToMin(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function listRecordings() {
  let files = [];
  try { files = fs.readdirSync(RECORDINGS_DIR); } catch { return []; }
  const schedule = loadSchedule();
  return files
    .filter(f => f.endsWith('.mp4') || f.endsWith('.m3u8'))
    .map(f => {
      const full = path.join(RECORDINGS_DIR, f);
      const stat = fs.statSync(full);
      const base = f.replace(/\.(mp4|m3u8)$/, '');
      const src = fs.existsSync(path.join(RECORDINGS_DIR, base + '.m3u8'))
        ? `${PUBLIC_BASE}/${base}.m3u8` : `${PUBLIC_BASE}/${base}.mp4`;
      return {
        id: base,
        title: scheduleTitleFor(base, schedule) || prettyTitle(base),
        date: stat.mtime.toISOString().slice(0, 10),
        duration: '',
        video: src,
        audio: fs.existsSync(path.join(RECORDINGS_DIR, base + '_audio.m3u8'))
          ? `${PUBLIC_BASE}/${base}_audio.m3u8` : ''
      };
    })
    .filter((r, i, a) => a.findIndex(x => x.id === r.id) === i)
    .sort((a, b) => b.date.localeCompare(a.date));
}
function prettyTitle(base) {
  // e.g. "servicio-2025-07-13-1030" -> "Servicio — 2025-07-13"
  const m = base.match(/(\d{4}-\d{2}-\d{2})/);
  const name = base.split(/[-_]/)[0] || 'Servicio';
  const nice = name.charAt(0).toUpperCase() + name.slice(1);
  return m ? `${nice} — ${m[1]}` : nice;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === '/api/recordings' && req.method === 'GET') {
    return json(res, 200, listRecordings());
  }

  if (url.pathname === '/api/schedule' && req.method === 'GET') {
    return json(res, 200, loadSchedule());
  }
  if (url.pathname === '/api/schedule' && req.method === 'POST') {
    const b = await body(req);
    if (b.key !== SECRET_KEY) return json(res, 401, { ok: false });
    const sched = Array.isArray(b.schedule) ? b.schedule.slice(0, 100).map(e => ({
      id: String(e.id || '').slice(0, 20) || Math.random().toString(36).slice(2, 9),
      title: String(e.title || '').slice(0, 80),
      day: Math.max(0, Math.min(6, parseInt(e.day, 10) || 0)),
      time: String(e.time || '10:00').slice(0, 5),
      code: String(e.code || '').slice(0, 60)
    })).filter(e => e.title) : [];
    try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2)); }
    catch { return json(res, 500, { ok: false }); }
    return json(res, 200, { ok: true, count: sched.length });
  }

  if (url.pathname === '/api/auth' && req.method === 'POST') {
    const b = await body(req);
    return b.key === SECRET_KEY ? json(res, 200, { ok: true }) : json(res, 401, { ok: false });
  }

  if (url.pathname === '/api/comment' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').slice(0, 40).trim();
    const text = String(b.text || '').slice(0, 500).trim();
    const code = String(b.code || 'servicio').slice(0, 60);
    if (!name || !text) return json(res, 400, { ok: false });
    const msg = { name, text, ts: Date.now(), code };
    // relay to streamers watching this code
    const set = streamers.get(code);
    if (set) for (const s of set) { try { s.send(JSON.stringify(msg)); } catch {} }
    // keep a private, streamer-only log (never served publicly)
    try {
      fs.appendFileSync(path.join(__dirname, `comments-${code}.log`),
        JSON.stringify(msg) + '\n');
    } catch {}
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

// WebSocket: only authenticated streamers receive the live comment feed
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('key') !== SECRET_KEY) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const code = url.searchParams.get('code') || 'servicio';
  if (!streamers.has(code)) streamers.set(code, new Set());
  streamers.get(code).add(ws);
  ws.send(JSON.stringify({ system: true, text: 'connected', ts: Date.now() }));
  ws.on('close', () => { const s = streamers.get(code); if (s) s.delete(ws); });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Edificando backend on :${PORT}`);
  console.log(`Recordings dir: ${RECORDINGS_DIR}`);
  if (SECRET_KEY === 'cambia-esta-clave') console.log('⚠  Set SECRET_KEY before going live.');
});
