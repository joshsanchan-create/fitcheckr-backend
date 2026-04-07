require("dotenv").config({ override: true, path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Config ──
const FASHN_API_KEY = process.env.FASHN_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FASHN_BASE = "https://api.fashn.ai/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";

// ── Middleware ──
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "20mb" })); // base64 images are large

// ── Landing page ──
app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FitCheckr Backend</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; color: #111; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    p { color: #555; margin-top: 0; }
    .status { display: flex; gap: 12px; margin: 24px 0; }
    .badge { padding: 6px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: 500; }
    .ok { background: #dcfce7; color: #166534; }
    .missing { background: #fee2e2; color: #991b1b; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { text-align: left; padding: 8px 12px; background: #f5f5f5; font-size: 0.8rem; color: #666; text-transform: uppercase; }
    td { padding: 10px 12px; border-top: 1px solid #eee; font-size: 0.9rem; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>FitCheckr Backend</h1>
  <p>API proxy for FASHN virtual try-on + Anthropic product lookup.</p>
  <div class="status">
    <span class="badge ok">● Running</span>
    <span class="badge ${FASHN_API_KEY ? "ok" : "missing"}">${FASHN_API_KEY ? "● FASHN configured" : "✕ FASHN missing"}</span>
    <span class="badge ${ANTHROPIC_API_KEY ? "ok" : "missing"}">${ANTHROPIC_API_KEY ? "● Anthropic configured" : "✕ Anthropic missing"}</span>
  </div>
  <table>
    <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
    <tr><td><code>GET</code></td><td><code>/api/health</code></td><td>Status check</td></tr>
    <tr><td><code>POST</code></td><td><code>/api/tryon</code></td><td>Submit try-on job</td></tr>
    <tr><td><code>GET</code></td><td><code>/api/tryon/status/:id</code></td><td>Poll job status</td></tr>
    <tr><td><code>GET</code></td><td><code>/api/proxy-image?url=</code></td><td>Proxy result image for extension</td></tr>
    <tr><td><code>POST</code></td><td><code>/api/product-lookup</code></td><td>Product search</td></tr>
  </table>
</body>
</html>`);
});

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    fashn_configured: !!FASHN_API_KEY,
    anthropic_configured: !!ANTHROPIC_API_KEY,
  });
});

// ────────────────────────────────────────────────────────
// POST /api/tryon — Submit a try-on job to FASHN
// Accepts extension format: { user_photo, garment_image_url, ... }
//      OR legacy format:    { model_image, garment_image, ... }
// Returns: { id }
// ────────────────────────────────────────────────────────
app.post("/api/tryon", async (req, res) => {
  if (!FASHN_API_KEY) {
    return res.status(500).json({ error: "FASHN_API_KEY not configured on server." });
  }

  const {
    // Extension field names
    user_photo,
    garment_image_url,
    // Legacy / direct field names
    model_image,
    garment_image,
    // Options
    mode = "balanced",
    category = "auto",
  } = req.body;

  const resolvedModelImage   = user_photo        || model_image;
  const resolvedGarmentImage = garment_image_url || garment_image;

  if (!resolvedModelImage || !resolvedGarmentImage) {
    return res.status(400).json({
      error: "Provide user_photo + garment_image_url (or model_image + garment_image).",
    });
  }

  // ── Garment image: if it's a URL, fetch it server-side and convert to base64 ──
  // Retailer CDNs (Nike, Zara, etc.) block third-party fetches via Referer/CORS,
  // so sending the raw URL to FASHN causes it to silently fail (completed, output: null).
  // Fetching here — from Node.js with no Referer — bypasses that restriction.
  let fashnGarmentImage = resolvedGarmentImage;
  if (resolvedGarmentImage && !resolvedGarmentImage.startsWith("data:")) {
    try {
      console.log("[tryon] category:", category, "| garment URL:", resolvedGarmentImage);
      console.log("[garment] Fetching via server:", resolvedGarmentImage);
      const garmentResp = await fetch(resolvedGarmentImage, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FitCheckr/1.0)",
          "Accept": "image/*,*/*",
        },
      });
      if (garmentResp.ok) {
        const garmentBuf = await garmentResp.arrayBuffer();
        const contentType = garmentResp.headers.get("content-type") || "image/jpeg";
        fashnGarmentImage = `data:${contentType};base64,${Buffer.from(garmentBuf).toString("base64")}`;
        console.log("[garment] Converted to base64, size:", garmentBuf.byteLength, "bytes");
      } else {
        console.warn("[garment] Fetch failed:", garmentResp.status, "— sending URL directly");
      }
    } catch (fetchErr) {
      console.warn("[garment] Fetch error:", fetchErr.message, "— sending URL directly");
    }
  }

  try {
    const fashnResp = await fetch(`${FASHN_BASE}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FASHN_API_KEY}`,
      },
      body: JSON.stringify({
        model_name: "tryon-v1.6",
        inputs: {
          model_image:   resolvedModelImage,
          garment_image: fashnGarmentImage,
          category,
          mode,
          segmentation_free: true,
          garment_photo_type: "auto",
          output_format: "jpeg",
          return_base64: false, // return CDN URL (more reliable for frontend display)
        },
      }),
    });

    const fashnData = await fashnResp.json();

    if (!fashnResp.ok) {
      const errMsg = fashnData.detail || fashnData.message || "FASHN API error";
      console.error("FASHN /run error:", fashnResp.status, errMsg);
      return res.status(fashnResp.status).json({ error: errMsg });
    }

    return res.json({ id: fashnData.id });
  } catch (err) {
    console.error("FASHN /run exception:", err.message);
    return res.status(500).json({ error: "Failed to reach FASHN API." });
  }
});

// ────────────────────────────────────────────────────────
// GET /api/tryon/status/:id — Poll a try-on job status
// Returns: { status, output?, error? }
// ────────────────────────────────────────────────────────
app.get("/api/tryon/status/:id", async (req, res) => {
  if (!FASHN_API_KEY) {
    return res.status(500).json({ error: "FASHN_API_KEY not configured on server." });
  }

  try {
    const statusResp = await fetch(`${FASHN_BASE}/status/${req.params.id}`, {
      headers: { Authorization: `Bearer ${FASHN_API_KEY}` },
    });

    const statusData = await statusResp.json();

    if (!statusResp.ok) {
      return res.status(statusResp.status).json({
        error: statusData.detail || statusData.message || "Status check failed",
      });
    }

    // Log the full FASHN response for debugging
    console.log("[status] FASHN response:", JSON.stringify(statusData));

    // Normalise to the shape the extension expects:
    //   { status, result_url?, error? }
    // FASHN output can be a string URL or an array; normalise to string.
    const rawOutput = statusData.output;
    const result_url = Array.isArray(rawOutput)
      ? (rawOutput.find(u => u && typeof u === "string") || null)
      : (typeof rawOutput === "string" && rawOutput ? rawOutput : null);

    if (statusData.status === "completed" && !result_url) {
      console.warn("[status] Job completed but output was empty:", JSON.stringify(rawOutput));
    }

    return res.json({
      status:     statusData.status,   // "starting" | "in_queue" | "processing" | "completed" | "failed"
      result_url,                       // populated when status === "completed"
      output:     rawOutput ?? null,    // keep original for debugging
      error:      statusData.error || null,
    });
  } catch (err) {
    console.error("FASHN /status exception:", err.message);
    return res.status(500).json({ error: "Failed to reach FASHN API." });
  }
});

// ────────────────────────────────────────────────────────
// GET /api/proxy-image?url=... — Proxy an external image (e.g. FASHN CDN)
// so the Chrome extension side-panel can display it without hitting CSP / CORS
// ────────────────────────────────────────────────────────
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url query param");

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).send("Invalid url");
  }

  // Only proxy HTTPS URLs to avoid fetching internal/private resources
  if (target.protocol !== "https:") {
    return res.status(400).send("Only https URLs are allowed");
  }

  try {
    const imgResp = await fetch(url);
    if (!imgResp.ok) {
      return res.status(imgResp.status).send(`Upstream error: ${imgResp.status}`);
    }

    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=3600");

    const buffer = await imgResp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("proxy-image error:", err.message);
    res.status(500).send("Image proxy error: " + err.message);
  }
});

// ────────────────────────────────────────────────────────
// POST /api/product-lookup — Look up product info from URL or search query
// Body: { url } or { query }
// Returns: { name, brand, price, image_url, color, available_sizes, product_url }
// ────────────────────────────────────────────────────────
app.post("/api/product-lookup", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server." });
  }

  const { url, query } = req.body;
  if (!url && !query) {
    return res.status(400).json({ error: "Provide either url or query." });
  }

  const prompt = url
    ? `Look up this product page and extract info. Do ONE web search for the URL.\n\nURL: ${url}\n\nReturn ONLY a JSON object (no markdown, no backticks):\n{"name":"product name","brand":"brand name","price":"price with currency","image_url":"direct image URL of the garment from the page's CDN","color":"color","available_sizes":["S","M","L"],"product_url":"${url}"}`
    : `Search for this clothing product. Do ONE web search.\n\nProduct: "${query}"\n\nReturn ONLY a JSON object (no markdown, no backticks):\n{"name":"product name","brand":"brand","price":"price with currency","image_url":"direct garment image URL","color":"color","available_sizes":["S","M","L"],"product_url":"URL to buy"}`;

  // Set a 40-second timeout via AbortController
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  try {
    const anthropicResp = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);
    const data = await anthropicResp.json();

    if (!anthropicResp.ok) {
      console.error("Anthropic error:", anthropicResp.status, data);
      return res.status(anthropicResp.status).json({
        error: data.error?.message || "Anthropic API error",
      });
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return res.json(parsed);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Product lookup timed out (40s). Try a garment image URL directly." });
    }
    console.error("Product lookup exception:", err.message);
    return res.status(500).json({ error: "Product lookup failed. " + err.message });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  FitCheckr backend running on http://localhost:${PORT}`);
  console.log(`  FASHN API key: ${FASHN_API_KEY ? "configured" : "MISSING — set FASHN_API_KEY"}`);
  console.log(`  Anthropic API key: ${ANTHROPIC_API_KEY ? "configured" : "MISSING — set ANTHROPIC_API_KEY"}`);
  console.log(`  Allowed origins: all (CORS open)\n`);
});
