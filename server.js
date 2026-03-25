require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3001;
const FASHN_API_KEY = process.env.FASHN_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FASHN_BASE = "https://api.fashn.ai/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  .split(",")
  .map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "20mb" }));
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", fashn_configured: !!FASHN_API_KEY, anthropic_configured: !!ANTHROPIC_API_KEY });
});
// POST /api/tryon — Submit try-on job to FASHN
app.post("/api/tryon", async (req, res) => {
  if (!FASHN_API_KEY) return res.status(500).json({ error: "FASHN_API_KEY not configured on server." });
  const { model_image, garment_image, mode = "balanced", category = "auto" } = req.body;
  if (!model_image || !garment_image) return res.status(400).json({ error: "model_image and garment_image are required." });
  try {
    const fashnResp = await fetch(FASHN_BASE + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + FASHN_API_KEY },
      body: JSON.stringify({
        model_name: "tryon-v1.6",
        inputs: { model_image, garment_image, category, mode, segmentation_free: true, garment_photo_type: "auto", output_format: "jpeg", return_base64: false },
      }),
    });
    const fashnData = await fashnResp.json();
    if (!fashnResp.ok) return res.status(fashnResp.status).json({ error: fashnData.detail || fashnData.message || "FASHN API error" });
    return res.json({ id: fashnData.id });
  } catch (err) {
    console.error("FASHN /run error:", err.message);
    return res.status(500).json({ error: "Failed to reach FASHN API." });
  }
});
// GET /api/tryon/status/:id — Poll try-on status
app.get("/api/tryon/status/:id", async (req, res) => {
  if (!FASHN_API_KEY) return res.status(500).json({ error: "FASHN_API_KEY not configured on server." });
  try {
    const statusResp = await fetch(FASHN_BASE + "/status/" + req.params.id, {
      headers: { Authorization: "Bearer " + FASHN_API_KEY },
    });
    const statusData = await statusResp.json();
    if (!statusResp.ok) return res.status(statusResp.status).json({ error: statusData.detail || "Status check failed" });
    return res.json({ status: statusData.status, output: statusData.output || null, error: statusData.error || null });
  } catch (err) {
    console.error("FASHN /status error:", err.message);
    return res.status(500).json({ error: "Failed to reach FASHN API." });
  }
});
// POST /api/product-lookup — Look up product info via Claude
app.post("/api/product-lookup", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server." });
  const { url, query } = req.body;
  if (!url && !query) return res.status(400).json({ error: "Provide either url or query." });
  const prompt = url
    ? "Look up this product page and extract info. Do ONE web search for the URL.\n\nURL: " + url + '\n\nReturn ONLY a JSON object (no markdown, no backticks):\n{"name":"product name","brand":"brand name","price":"price with currency","image_url":"direct image URL of the garment from the page CDN","color":"color","available_sizes":["S","M","L"],"product_url":"' + url + '"}'
    : 'Search for this clothing product. Do ONE web search.\n\nProduct: "' + query + '"\n\nReturn ONLY a JSON object (no markdown, no backticks):\n{"name":"product name","brand":"brand","price":"price with currency","image_url":"direct garment image URL","color":"color","available_sizes":["S","M","L"],"product_url":"URL to buy"}';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);
  try {
    const anthropicResp = await fetch(ANTHROPIC_BASE + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 600,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(timeout);
    const data = await anthropicResp.json();
    if (!anthropicResp.ok) return res.status(anthropicResp.status).json({ error: data.error?.message || "Anthropic API error" });
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return res.json(parsed);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return res.status(504).json({ error: "Product lookup timed out (40s)." });
    console.error("Product lookup error:", err.message);
    return res.status(500).json({ error: "Product lookup failed. " + err.message });
  }
});
app.listen(PORT, () => {
  console.log("\n  FitCheckr backend running on http://localhost:" + PORT);
  console.log("  FASHN API key: " + (FASHN_API_KEY ? "configured" : "MISSING"));
  console.log("  Anthropic API key: " + (ANTHROPIC_API_KEY ? "configured" : "MISSING"));
  console.log("  Allowed origins: " + allowedOrigins.join(", ") + "\n");
});
