// server.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

/**
 * Keep the raw body so we can verify HMAC signatures if WiFleet sends them.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer
    },
  })
);

/**
 * Health check / wake-up route
 */
app.get("/", (_req, res) => {
  res.status(200).send("✅ WiFleet-Connector running");
});

/**
 * WiFleet webhooks
 * - Verifies Bearer token (required)
 * - Verifies HMAC if header is present and WIFLEET_SECRET_KEY is set (optional)
 * Accept any HTTP method (POST/PUT/etc) to be flexible.
 */
app.all("/webhooks/:event", (req, res) => {
  // 1) Bearer auth check
  const expectedBearer = process.env.WIFLEET_BEARER_KEY || "";
  const auth = req.headers.authorization || "";
  if (!expectedBearer || !auth.startsWith("Bearer ") || auth !== `Bearer ${expectedBearer}`) {
    console.log("❌ Unauthorized webhook (bearer mismatch)");
    return res.status(401).send("Unauthorized");
  }

  // 2) Optional HMAC check (only if WiFleet sends a signature header)
  // Try common header names; if WiFleet docs specify a different one, tell me and I’ll adjust.
  const sigHeader =
    req.headers["x-wifleet-signature"] ||
    req.headers["x-signature"] ||
    req.headers["x-hub-signature-256"];
  const secret = process.env.WIFLEET_SECRET_KEY || "";

  if (sigHeader && secret) {
    const computed = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest("hex");

    // Some providers prefix with "sha256="
    const provided = String(sigHeader).replace(/^sha256=/i, "").toLowerCase();
    if (computed !== provided) {
      console.log("❌ Invalid HMAC signature");
      return res.status(401).send("Bad signature");
    }
  }

  console.log(`✅ Received WiFleet event: ${req.params.event} (${req.method})`);
  console.log("Body:", JSON.stringify(req.body));

  // TODO: upsert to your DB so /api/tracking can return real data
  return res.status(200).json({ ok: true });
});

/**
 * API for your Shopify page to read tracking data.
 * For now returns mock data until we wire DB + real payload mapping.
 * Example: GET /api/tracking?order=450789
 */
app.get("/api/tracking", (req, res) => {
  const orderId = req.query.order || "Unknown";
  res.json({
    order: orderId,
    status: "Assigned",
    driver: "Ahmed",
    phone: "+9651852000",
    eta: "12 min",
  });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
