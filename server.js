import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Basic health route
app.get("/", (req, res) => {
  res.send("✅ WiFleet-Connector running");
});

// WiFleet webhooks
app.all("/webhooks/:event", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.WIFLEET_BEARER_KEY}`) {
    console.log("❌ Unauthorized webhook");
    return res.status(401).send("Unauthorized");
  }
  console.log("✅ Received WiFleet event:", req.params.event);
  console.log(req.body);
  res.status(200).json({ success: true });
});


// API for Shopify page to read data
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
