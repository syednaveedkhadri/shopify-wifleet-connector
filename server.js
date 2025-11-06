// server.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

/** ===== In-memory store & SSE listeners ===== */
const store = new Map();              // orderKey -> {status, driverName, driverPhone, lat, lng, etaMinutes, timeline[], updatedAt}
const listeners = new Map();          // orderKey -> Set(res)

const nowISO = () => new Date().toISOString();

function broadcast(order, payload) {
  const set = listeners.get(order);
  if (!set || set.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch (_) {}
  }
}

function upsert(order, patch, timelineLabel = null) {
  const prev = store.get(order) || { timeline: [] };
  const next = {
    status: prev.status,
    driverName: prev.driverName,
    driverPhone: prev.driverPhone,
    lat: prev.lat,
    lng: prev.lng,
    etaMinutes: prev.etaMinutes,
    timeline: Array.isArray(prev.timeline) ? [...prev.timeline] : [],
    ...patch,
    updatedAt: nowISO(),
  };
  if (timelineLabel) {
    next.timeline.push({ ts: nowISO(), label: timelineLabel });
  }
  store.set(order, next);
  broadcast(order, { order, ...next });
  return next;
}

const pickKey = (b = {}) =>
  b.task_id || b.reference || b.order_id || b.order || b.id || b.job_id || b.code || b.task_code || b.tracking_id || b.tracking_code || null;

function normalizeAuth(h = "") {
  const m = h.trim().match(/^(Bearer|Token)\s+(.+)$/i);
  return (m ? m[2] : h).trim();
}

function statusToLabel(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/(accept|assigned)/.test(t)) return "Driver accepted your order";
  if (/(start|enroute|on_the_way|on-the-way|dispatched)/.test(t)) return "Driver is on the way";
  if (/(nearby|arriving)/.test(t)) return "Driver is nearby";
  if (/(delivered|completed|success)/.test(t)) return "Order delivered successfully";
  return null;
}

/** ===== Health ===== */
app.get("/", (_req, res) => res.send("✅ WiFleet-Connector running"));

/** ===== Secure webhooks from WiFleet ===== */
app.all("/webhooks/:event", (req, res) => {
  const expected = (process.env.WIFLEET_BEARER_KEY || "").trim();
  const got = normalizeAuth(req.headers.authorization || "");
  if (!expected || !got || got !== expected) {
    console.log("❌ Unauthorized webhook (bearer mismatch)");
    return res.status(401).send("Unauthorized");
  }

  // Optional HMAC verify (if WiFleet sends signature)
  const sig = req.headers["x-wifleet-signature"] || req.headers["x-signature"] || req.headers["x-hub-signature-256"];
  const secret = (process.env.WIFLEET_SECRET_KEY || "").trim();
  if (sig && secret) {
    const calc = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest("hex");
    const provided = String(sig).replace(/^sha256=/i, "").toLowerCase();
    if (calc !== provided) return res.status(401).send("Bad signature");
  }

  const b = req.body || {};
  const order = pickKey(b);
  console.log(`✅ Received WiFleet event: ${req.params.event} for`, order);
  // Map incoming payload to our fields
  const raw = (b.status || b.task_status || "").toString();
  const label = statusToLabel(raw);
  const patch = {
    status:
      /accept|assigned/i.test(raw) ? "accepted" :
      /start|enroute|on_the_way|on-the-way|dispatched/i.test(raw) ? "enroute" :
      /nearby|arriving/i.test(raw) ? "nearby" :
      /delivered|completed|success/i.test(raw) ? "completed" :
      undefined,
    driverName  : b.driver?.name  || b.driver_name  || b.courier_name  || undefined,
    driverPhone : b.driver?.phone || b.driver_phone || b.courier_phone || undefined,
    lat         : b.location?.lat ?? b.lat ?? b.latitude ?? undefined,
    lng         : b.location?.lng ?? b.lng ?? b.longitude ?? undefined,
    etaMinutes  : b.eta_minutes ?? b.eta ?? undefined,
  };

  if (!order) {
    console.log("ℹ️ No task identifier in payload");
    return res.status(200).json({ ok: true, note: "no task id in payload" });
  }

  upsert(order, patch, label);
  return res.status(200).json({ ok: true });
});

/** ===== REST: current snapshot ===== */
app.get("/api/tracking", (req, res) => {
  const order = (req.query.order || "").toString().trim();
  if (!order) return res.status(400).json({ error: "missing order" });
  const data = store.get(order) || { status: "pending", timeline: [] };
  res.json({ order, ...data });
});

/** ===== SSE: live stream ===== */
app.get("/events", (req, res) => {
  const order = (req.query.order || "").toString().trim();
  if (!order) return res.status(400).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send current state immediately
  const snapshot = store.get(order) || { status: "pending", timeline: [] };
  res.write(`data: ${JSON.stringify({ order, ...snapshot })}\n\n`);

  // Register listener
  if (!listeners.has(order)) listeners.set(order, new Set());
  const set = listeners.get(order);
  set.add(res);

  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) listeners.delete(order);
  });
});

/** ===== Embedded widget (live, timeline, driver, map) ===== */
app.get("/widget", (req, res) => {
  const order = (req.query.order || "").toString().trim();
  const brand = "mobile2000";
  const support = "https://wa.me/9651852000?text=";
  if (!order) return res.status(400).send("Missing ?order=");

  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brand} • Track</title>
<style>
  :root{--brand:#00FFFF}
  body{font-family:ui-sans-serif,system-ui,-apple-system;margin:0;padding:16px;background:#fff}
  .card{border:1px solid #e5e7eb;border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);max-width:760px;margin:auto}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:6px;background:var(--brand);color:#000;padding:6px 10px;border-radius:9999px;font-weight:700}
  .title{font-size:20px;font-weight:800;margin:8px 0}
  .sub{color:#4b5563;margin:0 0 12px}
  .driver{display:flex;align-items:center;gap:10px;border:1px solid #e5e7eb;border-radius:12px;padding:10px;margin:8px 0}
  .driver .name{font-weight:700}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
  .pill{background:#f1f5f9;color:#000;padding:6px 10px;border-radius:9999px;font-weight:600}
  .map{width:100%;height:280px;border:0;border-radius:12px}
  .timeline{list-style:none;margin:10px 0 0;padding:0}
  .timeline li{padding:8px 0;border-bottom:1px dashed #e5e7eb;font-size:14px}
  .time{color:#6b7280;margin-left:6px;font-size:12px}
</style>
</head>
<body>
<div class="card">
  <div class="row"><span class="chip">${brand} • Track</span><a href="${support}" target="_blank">Need help?</a></div>
  <div class="title">Order ${order}</div>
  <p class="sub" id="status">Waiting for driver updates…</p>

  <div class="driver" id="driver" style="display:none">
    <div style="width:36px;height:36px;background:#e5e7eb;border-radius:9999px"></div>
    <div>
      <div class="name" id="dname"></div>
      <div><a id="dphone" href="#" style="text-decoration:none"></a></div>
    </div>
  </div>

  <div class="meta" id="meta"></div>

  <div id="mapWrap" style="margin-top:8px;display:none">
    <iframe class="map" id="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </div>

  <h3 style="margin-top:14px;margin-bottom:6px">Timeline</h3>
  <ul class="timeline" id="tl"></ul>
</div>

<script>
const order = ${JSON.stringify(order)};
const $ = s => document.querySelector(s);

function setStatus(s){
  $("#status").textContent = s;
}
function setDriver(name, phone){
  if(name || phone){
    $("#driver").style.display="flex";
    $("#dname").textContent = name || "";
    const p = $("#dphone");
    if(phone){ p.textContent = phone; p.href = "tel:"+phone.replace(/\\s+/g,""); } else { p.textContent=""; p.removeAttribute("href"); }
  } else {
    $("#driver").style.display="none";
  }
}
function setMeta(eta){
  $("#meta").innerHTML = eta ? '<span class="pill">ETA: '+eta+' min</span>' : '';
}
function setMap(lat,lng){
  if(lat==null || lng==null){ $("#mapWrap").style.display="none"; return; }
  $("#mapWrap").style.display="block";
  $("#map").src = "https://maps.google.com/maps?q="+lat+","+lng+"&z=15&output=embed";
}
function setTimeline(items){
  const html = (items||[]).map(it => {
    const ts = new Date(it.ts);
    const t = ts.toLocaleString();
    return '<li>'+it.label+' <span class="time">'+t+'</span></li>';
  }).join("");
  $("#tl").innerHTML = html || '<li>No updates yet.</li>';
}

function render(data){
  const st = data.status;
  if(st==="accepted") setStatus("✅ Driver accepted your order");
  else if(st==="enroute") setStatus("🚚 Driver is on the way");
  else if(st==="nearby") setStatus("📍 Driver is nearby");
  else if(st==="completed") setStatus("🎉 Order delivered successfully");
  else setStatus("⏳ Waiting for driver updates…");

  setDriver(data.driverName, data.driverPhone);
  setMeta(data.etaMinutes);
  setMap(data.lat, data.lng);
  setTimeline(data.timeline);
}

// initial snapshot
fetch("/api/tracking?order="+encodeURIComponent(order)).then(r=>r.json()).then(render).catch(()=>{});

// live updates via Server-Sent Events
const es = new EventSource("/events?order="+encodeURIComponent(order));
es.onmessage = (e) => {
  try { render(JSON.parse(e.data)); } catch(_){}
};
</script>

</body></html>`);
});

/** ===== Simple mock endpoints for manual testing ===== */
app.get("/api/mock/:order/:status", (req, res) => {
  const order = req.params.order;
  const st = req.params.status;
  const label = statusToLabel(st);
  upsert(order, { status: st }, label || ("Status: "+st));
  res.json({ ok: true, order, status: st });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
