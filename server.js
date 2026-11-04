// SG Bus & MRT: manual board/alight planner using LTA DataMall (bus stops, routes, live arrivals, train alerts)
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.LTA_API_KEY;
if (!KEY) { console.error('Missing LTA_API_KEY. Run:  LTA_API_KEY=xxxx node server.js'); process.exit(1); }
const LTA = 'https://datamall2.mytransport.sg/ltaodataservice';

async function lta(p) {
  const r = await fetch(LTA + p, { headers: { AccountKey: KEY, accept: 'application/json' } });
  if (!r.ok) throw new Error(`LTA ${r.status} on ${p}`);
  return (await r.json()).value || [];
}
// Cache with in-flight de-duplication; serves stale data if a refresh fails.
function cached(ttlMs, fn) {
  let data = null, at = 0, pending = null;
  return async () => {
    if (data && Date.now() - at < ttlMs) return data;
    if (!pending) pending = fn().then(d => { data = d; at = Date.now(); return d; }).finally(() => { pending = null; });
    try { return await pending; } catch (e) { if (data) return data; throw e; }
  };
}

// Serve the web app files from ./public, or from the project root if a GitHub upload flattened the folders.
// Only this fixed list is ever served, so server.js and .env stay private.
const WEB_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);
function findWebFile(name) {
  if (!WEB_FILES.has(name)) return null;
  for (const dir of ['public', 'public/icons', 'icons', '.']) { const f = path.join(__dirname, dir, name); if (fs.existsSync(f)) return f; }
  return null;
}
const sendWeb = name => (req, res) => { const f = findWebFile(name); f ? res.sendFile(f) : res.status(404).send('File not found on server: ' + name); };
app.get(['/', '/index.html'], sendWeb('index.html'));
app.get('/manifest.webmanifest', sendWeb('manifest.webmanifest'));
app.get('/sw.js', sendWeb('sw.js'));
app.get('/icons/:name', (req, res) => sendWeb(req.params.name)(req, res));

/* ---------- Bus + MRT planner: user picks where to board and alight ---------- */
async function ltaRaw(p) {
  const r = await fetch(LTA + p, { headers: { AccountKey: KEY, accept: 'application/json' } });
  if (!r.ok) throw new Error(`LTA ${r.status} on ${p}`);
  return r.json();
}
const getBusData = cached(24 * 3600 * 1000, async () => {
  const pull = async (path) => {
    const out = [];
    for (let skip = 0; ; skip += 4000) {
      const pages = await Promise.all(Array.from({ length: 8 }, (_, i) => lta(`${path}?$skip=${skip + i * 500}`)));
      let done = false; for (const p of pages) { out.push(...p); if (p.length < 500) done = true; }
      if (done) return out;
    }
  };
  const [sr, rr] = await Promise.all([pull('/BusStops'), pull('/BusRoutes')]);
  const stops = new Map(sr.map(x => [x.BusStopCode, { code: x.BusStopCode, name: x.Description, road: x.RoadName, lat: x.Latitude, lon: x.Longitude }]));
  const routes = new Map(), at = new Map();
  for (const r of rr) { const k = `${r.ServiceNo}|${r.Direction}`; if (!routes.has(k)) routes.set(k, []); routes.get(k).push({ code: r.BusStopCode, seq: r.StopSequence, dist: +r.Distance || 0, op: r.Operator }); }
  for (const [k, a] of routes) { a.sort((x, y) => x.seq - y.seq); a.forEach((x, i) => { if (!at.has(x.code)) at.set(x.code, new Map()); at.get(x.code).set(k, i); }); }
  console.log(`Bus data: ${stops.size} stops, ${routes.size} service directions`);
  return { stops, routes, at };
});

app.get('/api/transit/busstops', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim(); if (q.length < 2) return res.json([]);
    const { stops } = await getBusData(); const out = [];
    for (const s of stops.values()) if (s.code.startsWith(q) || s.name.toLowerCase().includes(q) || s.road.toLowerCase().includes(q)) out.push(s);
    out.sort((a, b) => (b.name.toLowerCase().startsWith(q)) - (a.name.toLowerCase().startsWith(q)));
    res.json(out.slice(0, 8));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/transit/bus', async (req, res) => {
  try {
    const { from, to } = req.query; const { stops, routes, at } = await getBusData();
    const A = at.get(from), B = at.get(to);
    if (!A || !B) return res.status(404).json({ error: 'Unknown bus stop code' });
    const best = new Map();
    for (const [k, i] of A) {
      const j = B.get(k); if (j === undefined || j <= i) continue;       // must reach the alight stop AFTER boarding
      const r = routes.get(k), dist = r[j].dist - r[i].dist, [service] = k.split('|');
      const path = r.slice(i, j + 1).map(x => stops.get(x.code)).filter(Boolean).map(x => [+x.lat, +x.lon]);
      const d = { service, path, stops: j - i, distKm: +dist.toFixed(1), rideMin: Math.max(2, Math.round(dist / 18 * 60)), op: r[i].op };
      if (!best.has(service) || d.stops < best.get(service).stops) best.set(service, d);
    }
    const list = [...best.values()], arr = {};
    for (const path of ['/v3/BusArrival', '/BusArrival']) {
      try {
        const a = await ltaRaw(`${path}?BusStopCode=${from}`);
        for (const x of a.Services || []) arr[x.ServiceNo] = [x.NextBus, x.NextBus2, x.NextBus3].filter(b => b && b.EstimatedArrival)
          .map(b => ({ min: Math.max(0, Math.round((new Date(b.EstimatedArrival) - Date.now()) / 60000)), load: b.Load }));
        break;
      } catch {}
    }
    list.forEach(d => d.arrivals = arr[d.service] || []);
    list.sort((a, b) => (a.arrivals[0]?.min ?? 999) - (b.arrivals[0]?.min ?? 999));
    res.json({ from: stops.get(from), to: stops.get(to), services: list });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// MRT network (bus-free, static). Interchanges are stations sharing a name. LRT and Cross Island Line not included.
// Station list as of late 2025; edit here if new stations open.
const MRT = `NS1 Jurong East,NS2 Bukit Batok,NS3 Bukit Gombak,NS4 Choa Chu Kang,NS5 Yew Tee,NS7 Kranji,NS8 Marsiling,NS9 Woodlands,NS10 Admiralty,NS11 Sembawang,NS12 Canberra,NS13 Yishun,NS14 Khatib,NS15 Yio Chu Kang,NS16 Ang Mo Kio,NS17 Bishan,NS18 Braddell,NS19 Toa Payoh,NS20 Novena,NS21 Newton,NS22 Orchard,NS23 Somerset,NS24 Dhoby Ghaut,NS25 City Hall,NS26 Raffles Place,NS27 Marina Bay,NS28 Marina South Pier,
EW1 Pasir Ris,EW2 Tampines,EW3 Simei,EW4 Tanah Merah,EW5 Bedok,EW6 Kembangan,EW7 Eunos,EW8 Paya Lebar,EW9 Aljunied,EW10 Kallang,EW11 Lavender,EW12 Bugis,EW13 City Hall,EW14 Raffles Place,EW15 Tanjong Pagar,EW16 Outram Park,EW17 Tiong Bahru,EW18 Redhill,EW19 Queenstown,EW20 Commonwealth,EW21 Buona Vista,EW22 Dover,EW23 Clementi,EW24 Jurong East,EW25 Chinese Garden,EW26 Lakeside,EW27 Boon Lay,EW28 Pioneer,EW29 Joo Koon,EW30 Gul Circle,EW31 Tuas Crescent,EW32 Tuas West Road,EW33 Tuas Link,CG1 Expo,CG2 Changi Airport,
CC1 Dhoby Ghaut,CC2 Bras Basah,CC3 Esplanade,CC4 Promenade,CC5 Nicoll Highway,CC6 Stadium,CC7 Mountbatten,CC8 Dakota,CC9 Paya Lebar,CC10 MacPherson,CC11 Tai Seng,CC12 Bartley,CC13 Serangoon,CC14 Lorong Chuan,CC15 Bishan,CC16 Marymount,CC17 Caldecott,CC19 Botanic Gardens,CC20 Farrer Road,CC21 Holland Village,CC22 Buona Vista,CC23 one-north,CC24 Kent Ridge,CC25 Haw Par Villa,CC26 Pasir Panjang,CC27 Labrador Park,CC28 Telok Blangah,CC29 HarbourFront,CE1 Bayfront,CE2 Marina Bay,
DT1 Bukit Panjang,DT2 Cashew,DT3 Hillview,DT5 Beauty World,DT6 King Albert Park,DT7 Sixth Avenue,DT8 Tan Kah Kee,DT9 Botanic Gardens,DT10 Stevens,DT11 Newton,DT12 Little India,DT13 Rochor,DT14 Bugis,DT15 Promenade,DT16 Bayfront,DT17 Downtown,DT18 Telok Ayer,DT19 Chinatown,DT20 Fort Canning,DT21 Bencoolen,DT22 Jalan Besar,DT23 Bendemeer,DT24 Geylang Bahru,DT25 Mattar,DT26 MacPherson,DT27 Ubi,DT28 Kaki Bukit,DT29 Bedok North,DT30 Bedok Reservoir,DT31 Tampines West,DT32 Tampines,DT33 Tampines East,DT34 Upper Changi,DT35 Expo,
NE1 HarbourFront,NE3 Outram Park,NE4 Chinatown,NE5 Clarke Quay,NE6 Dhoby Ghaut,NE7 Little India,NE8 Farrer Park,NE9 Boon Keng,NE10 Potong Pasir,NE11 Woodleigh,NE12 Serangoon,NE13 Kovan,NE14 Hougang,NE15 Buangkok,NE16 Sengkang,NE17 Punggol,NE18 Punggol Coast,
TE1 Woodlands North,TE2 Woodlands,TE3 Woodlands South,TE4 Springleaf,TE5 Lentor,TE6 Mayflower,TE7 Bright Hill,TE8 Upper Thomson,TE9 Caldecott,TE11 Stevens,TE12 Napier,TE13 Orchard Boulevard,TE14 Orchard,TE15 Great World,TE16 Havelock,TE17 Outram Park,TE18 Maxwell,TE19 Shenton Way,TE20 Marina Bay,TE22 Gardens by the Bay,TE23 Tanjong Rhu,TE24 Katong Park,TE25 Tanjong Katong,TE26 Marine Parade,TE27 Marine Terrace,TE28 Siglap,TE29 Bayshore`;
const LINE_NAME = { NS: 'North-South', EW: 'East-West', CG: 'Changi Airport branch', CC: 'Circle', CE: 'Circle (Bayfront branch)', DT: 'Downtown', NE: 'North East', TE: 'Thomson-East Coast' };
const LTA_LINE = { NS: 'NSL', EW: 'EWL', CG: 'CGL', CC: 'CCL', CE: 'CCL', DT: 'DTL', NE: 'NEL', TE: 'TEL' };
const stn = new Map(), adj = new Map(), byName = {}, byPrefix = {};
for (const t of MRT.split(',')) { const [c, ...n] = t.trim().split(' '); stn.set(c, n.join(' ')); }
const link = (a, b, w) => { for (const [x, y] of [[a, b], [b, a]]) { if (!adj.has(x)) adj.set(x, []); adj.get(x).push([y, w]); } };
for (const c of stn.keys()) { const p = c.match(/^[A-Z]+/)[0]; (byPrefix[p] = byPrefix[p] || []).push(c); (byName[stn.get(c)] = byName[stn.get(c)] || []).push(c); }
for (const [p, list] of Object.entries(byPrefix)) {
  list.sort((a, b) => +a.slice(p.length) - +b.slice(p.length));
  if (p === 'CG') list.unshift('EW4'); if (p === 'CE') list.unshift('CC4');
  for (let i = 0; i < list.length - 1; i++) link(list[i], list[i + 1], 2.5);        // ~2.5 min per station
}
for (const codes of Object.values(byName)) for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) link(codes[i], codes[j], 5); // ~5 min interchange

app.get('/api/transit/stations', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim(); if (q.length < 2) return res.json([]);
  res.json(Object.entries(byName).filter(([n, c]) => n.toLowerCase().includes(q) || c.some(x => x.toLowerCase() === q))
    .map(([name, codes]) => ({ name, codes })).sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)).slice(0, 8));
});


const stationPos = new Map();
async function geoStation(name) {
  if (stationPos.has(name)) return stationPos.get(name);
  try {
    const r = await fetch(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(name + ' MRT STATION')}&returnGeom=Y&getAddrDetails=Y&pageNum=1`);
    const res = (await r.json()).results || [], x = res.find(y => /MRT STATION/i.test(y.SEARCHVAL)) || res[0];
    const p = x ? { name, lat: +x.LATITUDE, lon: +x.LONGITUDE } : null;
    if (p) stationPos.set(name, p); return p;
  } catch { return null; }
}

app.get('/api/transit/train', async (req, res) => {
  try {
    const src = byName[req.query.from], dst = byName[req.query.to];
    if (!src || !dst) return res.status(404).json({ error: 'Unknown station' });
    if (req.query.from === req.query.to) return res.status(400).json({ error: 'Board and alight stations are the same' });
    const dist = new Map(), prev = new Map(), todo = new Set(stn.keys());
    for (const c of stn.keys()) dist.set(c, Infinity); for (const c of src) dist.set(c, 0);
    while (todo.size) {
      let u = null; for (const c of todo) if (u === null || dist.get(c) < dist.get(u)) u = c;
      if (dist.get(u) === Infinity) break; todo.delete(u);
      for (const [v, w] of adj.get(u) || []) if (dist.get(u) + w < dist.get(v)) { dist.set(v, dist.get(u) + w); prev.set(v, u); }
    }
    const end = dst.reduce((a, b) => dist.get(a) <= dist.get(b) ? a : b);
    const path = [end]; while (prev.has(path[0])) path.unshift(prev.get(path[0]));
    const legs = []; let lines = new Set();
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (stn.get(a) === stn.get(b)) continue;                                   // interchange walk
      const pa = a.match(/^[A-Z]+/)[0], pb = b.match(/^[A-Z]+/)[0];
      const p = ['CG', 'CE'].includes(pa) ? pa : pb;                              // branch edges belong to the branch line
      lines.add(LTA_LINE[p]);
      const last = legs[legs.length - 1];
      if (last && last.prefix === p) { last.to = stn.get(b); last.stops++; last.minutes += 2.5; }
      else legs.push({ prefix: p, line: LINE_NAME[p], from: stn.get(a), to: stn.get(b), stops: 1, minutes: 2.5 });
    }
    let alerts = { status: 1, messages: [], affected: false };
    try {
      const a = (await ltaRaw('/TrainServiceAlerts')).value || {};
      const aff = (a.AffectedSegments || []).map(x => x.Line);
      alerts = { status: a.Status, messages: (a.Message || []).map(m => m.Content), affected: aff.some(l => lines.has(l)) };
    } catch {}
    const points = (await Promise.all([legs[0].from, ...legs.map(l => l.to)].map(geoStation))).filter(Boolean);
    res.json({ points, from: req.query.from, to: req.query.to, minutes: Math.round(dist.get(end)), transfers: legs.length - 1, legs, alerts });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  getBusData().catch(e => console.error('Initial bus data load failed:', e.message));   // warm cache
});
