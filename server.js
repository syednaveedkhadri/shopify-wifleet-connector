import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true })); // ➕ in case WiFleet posts form-encoded

const mask = (s="") => (s.length<=8 ? "****" : `${s.slice(0,4)}…${s.slice(-4)} (${s.length})`);
const normalizeAuth = (h="") => { const m = h.trim().match(/^(Bearer|Token)\s+(.+)$/i); return (m?m[2]:h).trim(); };

app.get("/", (_req, res) => res.send("✅ WiFleet-Connector running"));

/* ➕ TEMP DEBUG: No auth, logs everything so we can see exactly what WiFleet sends */
app.all("/webhooks-debug/:event", (req, res) => {
  console.log("🐞 DEBUG hit:", req.params.event, req.method);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  res.status(200).json({ ok: true, debug: true });
});

app.all("/webhooks/:event", (req, res) => {
  const expected = (process.env.WIFLEET_BEARER_KEY || "").trim();
  const got = normalizeAuth(req.headers.authorization || "");

  console.log(`🔎 Parsed token: ${mask(got)} | Expected: ${mask(expected)}`);
  if (!expected || !got || got !== expected) {
    console.log("❌ Unauthorized webhook (bearer mismatch)");
    return res.status(401).send("Unauthorized");
  }

  const sig = req.headers["x-wifleet-signature"] || req.headers["x-signature"] || req.headers["x-hub-signature-256"];
  const secret = (process.env.WIFLEET_SECRET_KEY || "").trim();
  if (sig && secret) {
    const computed = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest("hex");
    const provided = String(sig).replace(/^sha256=/i, "").toLowerCase();
    if (computed !== provided) return res.status(401).send("Bad signature");
  }

  console.log(`✅ Received WiFleet event: ${req.params.event} (${req.method})`);
  console.log("Body:", req.body);
  res.status(200).json({ ok: true });
});

app.get("/api/tracking", (req, res) => {
  const order = req.query.order || "Unknown";
  res.json({ order, status: "Assigned", driver: "Ahmed", phone: "+9651852000", eta: "12 min" });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
