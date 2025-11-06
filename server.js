// server.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// Keep raw body for optional HMAC verification
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

/** In-memory store: { [orderKey]: { status, driverName, driverPhone, lat, lng, etaMinutes, updatedAt } } */
const store = new Map();

/** Helpers */
const now = () => new Date().toISOString();
const mask = (s = "") => (s.length <= 8 ? "****" : `${s.slice(0,4)}…${s.slice(-4)} (${s.length})`);
const normalizeAuth = (h = "") => {
  const m = h.trim().match(/^(Bearer|Token)\s+(.+)$/i);
  return (m ? m[2] : h).trim();
};
const pickKey = (b = {}) =>
  b.task_id || b.reference || b.order_id || b.order || b.id || b.job_id || null;

const upsert = (key, patch) => {
  const prev = store.get(key) || {};
  const next = { ...prev, ...patch, updatedAt: now() };
  store.set(key, next);
  return next;
};

/** Health */
app.get("/", (_req, res) => res.send("✅ WiFleet-Connector running"));

/** SECURE webhooks (use these in WiFleet): /webhooks/<event> */
app.all("/webhooks/:event", (req, res) => {
  const expected = (process.env.WIFLEET_BEARER_KEY || "").trim();
  const header = normalizeAuth(req.headers.authorization || "");
  if (!expected || !header || header !== expected) {
    console.log("❌ Unauthorized webhook (bearer mismatch)");
    return res.status(401).send("Unauthorized");
  }

  // Optional HMAC if WiFleet sends it
  const sig = req.headers["x-wifleet-signature"] || req.headers["x-signature"] || req.headers["x-hub-signature-256"];
  const secret = (process.env.WIFLEET_SECRET_KEY || "").trim();
  if (sig && secret) {
    const calc = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest("hex");
    const provided = String(sig).replace(/^sha256=/i, "").toLowerCase();
    if (calc !== provided) return res.status(401).send("Bad signature");
  }

  const evt = req.params.event;
  const b = req.body || {};
  const key = pickKey(b);

  console.log(`✅ Received WiFleet event: ${evt}`);
  console.log("Body:", JSON.stringify(b));

  if (!key) {
    // We need a key to track per order/task
    return res.status(200).json({ ok: true, note: "no key (task_id/reference/order_id) found" });
  }

  // Map WiFleet payload to our store fields (be flexible with names)
  const statusRaw = (b.status || b.task_status || "").toString().toLowerCase();

  // Normalize a few common statuses to the three you want to display
  let status = undefined;
  if (/(accept|assigned)/.test(statusRaw)) status = "accepted";       // Driver accepted
  if (/(start|enroute|on_the_way|on-the-way|dispatched)/.test(statusRaw)) status = "enroute";
  if (/(nearby|arriving)/.test(statusRaw)) status = "nearby";
  if (/(delivered|completed|success)/.test(statusRaw)) status = "completed";

  const driverName  = b.driver?.name  || b.driver_name  || b.courier_name || undefined;
  const driverPhone = b.driver?.phone || b.driver_phone || b.courier_phone || undefined;
  const lat = b.location?.lat ?? b.lat ?? b.latitude;
  const lng = b.location?.lng ?? b.lng ?? b.longitude;
  const etaMinutes = b.eta_minutes ?? b.eta ?? undefined;

  upsert(key, { status, driverName, driverPhone, lat, lng, etaMinutes });

  return res.status(200).json({ ok: true });
});

/** Simple tracking API: GET /api/tracking?order=<task_id|reference|order_id> */
app.get("/api/tracking", (req, res) => {
  const key = (req.query.order || "").toString().trim();
  if (!key) return res.status(400).json({ error: "missing order" });
  const data = store.get(key) || { status: "pending" };
  res.json({ order: key, ...data });
});

/** Embedded widget (iframe): GET /widget?order=<id> */
app.get("/widget", (req, res) => {
  const order = (req.query.order || "").toString().trim();
  const brand = "mobile2000";
  const support = "https://wa.me/9651852000?text=";

  if (!order) return res.status(400).send("Missing ?order=");

  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Track ${brand}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;padding:16px;background:#fff}
  .card{border:1px solid #e5e7eb;border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);max-width:720px;margin:auto}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:6px;background:#00FFFF;color:#000;font-weight:700;padding:6px 10px;border-radius:9999px}
  .title{font-size:20px;font-weight:800;margin:8px 0}
  .sub{color:#4b5563;margin:0 0 12px}
  .btn{background:#111827;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:700}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  iframe.map{width:100%;height:280px;border:0;border-radius:12px}
</style>
</head>
<body>
<div class="card">
  <div class="row"><span class="chip">${brand} • Track</span><a href="${support}" target="_blank">Need help?</a></div>
  <div class="title">Order ${order}</div>
  <p class="sub" id="status">Waiting for driver updates…</p>
  <div class="meta" id="meta"></div>
  <div id="mapWrap" style="margin-top:10px;display:none">
    <iframe class="map" id="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </div>
  <div id="rateWrap" style="display:none;margin-top:10px">
    <p class="sub">Order delivered. Please rate our service:</p>
    <div id="stars" style="font-size:24px;cursor:pointer">⭐️⭐️⭐️⭐️⭐️</div>
    <textarea id="cmt" rows="3" style="width:100%;margin-top:8px" placeholder="Comments (optional)"></textarea>
    <button class="btn" onclick="alert('Thanks for your feedback!')">Submit</button>
  </div>
</div>
<script>
const order = ${JSON.stringify(order)};
const $ = s => document.querySelector(s);
function setStatus(text){ $("#status").textContent = text; }
function setMeta(items){
  $("#meta").innerHTML = items.filter(Boolean).map(t=>'<span class="chip" style="background:#eef; color:#000">'+t+'</span>').join(' ');
}
function showMap(lat,lng){
  if(lat==null||lng==null){ $("#mapWrap").style.display="none"; return; }
  $("#mapWrap").style.display="block";
  $("#map").src = "https://maps.google.com/maps?q="+lat+","+lng+"&z=15&output=embed";
}
async function tick(){
  try{
    const res = await fetch("/api/tracking?order="+encodeURIComponent(order));
    const data = await res.json();
    let status = (data.status||"pending");

    if(status==="accepted"){ setStatus("✅ Driver accepted your order"); }
    else if(status==="enroute"){ setStatus("🚚 Driver is on the way"); }
    else if(status==="nearby"){ setStatus("📍 Driver is nearby"); }
    else if(status==="completed"){ setStatus("🎉 Order delivered successfully"); $("#rateWrap").style.display="block"; }
    else { setStatus("⏳ Waiting for driver updates…"); }

    setMeta([
      data.driverName ? "Driver: "+data.driverName : "",
      data.driverPhone ? "Phone: "+data.driverPhone : "",
      data.etaMinutes ? "ETA: "+data.etaMinutes+" min" : ""
    ]);
    showMap(data.lat, data.lng);
  }catch(e){ console.error(e); }
}
tick(); setInterval(tick, 5000);
</script>
</body></html>`);
});

/** Simple mock (kept for quick manual tests) */
app.get("/api/mock/:order/:status", (req, res) => {
  const key = req.params.order;
  upsert(key, { status: req.params.status });
  res.json({ ok: true, order: key, status: req.params.status });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
