require("dotenv").config({ override: true, path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Config ──
const FASHN_API_KEY      = process.env.FASHN_API_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET         = process.env.JWT_SECRET || "dev-secret-change-in-production";
const FASHN_BASE         = "https://api.fashn.ai/v1";
const ANTHROPIC_BASE     = "https://api.anthropic.com/v1";

// ── Auth config (set these in Render environment variables) ──
const BACKEND_URL          = process.env.BACKEND_URL || "https://fitcheckr-backend-1.onrender.com";
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;

// ── Supabase (wardrobe cloud sync) ──
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Setup instructions: see SUPABASE_SETUP.md or the README
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WARDROBE_BUCKET      = "wardrobe-results";

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ── Middleware ──
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "20mb" })); // base64 images are large

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

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
// POST /api/auth/google — Exchange a Google OAuth access_token for a
// FitCheckr session JWT.  The access_token comes from chrome.identity
// running in the extension and is verified server-side with Google.
// Returns: { token, user: { id, email, name, picture } }
// ────────────────────────────────────────────────────────
app.post("/api/auth/google", async (req, res) => {
  const { access_token } = req.body || {};
  if (!access_token) {
    return res.status(400).json({ error: "access_token is required" });
  }

  try {
    // Verify the token by calling Google's userinfo endpoint
    const googleResp = await fetch(
      `https://www.googleapis.com/oauth2/v1/userinfo?access_token=${encodeURIComponent(access_token)}`
    );
    if (!googleResp.ok) {
      return res.status(401).json({ error: "Invalid or expired Google token" });
    }
    const profile = await googleResp.json();
    // profile: { id, email, name, picture, verified_email, ... }

    const payload = {
      sub:     profile.id,
      email:   profile.email,
      name:    profile.name,
      picture: profile.picture,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });

    console.log("[auth] Signed in:", profile.email);
    return res.json({
      token,
      user: { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture },
    });
  } catch (err) {
    console.error("[auth] Google sign-in error:", err.message);
    return res.status(500).json({ error: "Authentication failed" });
  }
});

// ────────────────────────────────────────────────────────
// GET /api/me — Verify the FitCheckr session JWT and return the
// current user profile.  Used by the extension on startup.
// ────────────────────────────────────────────────────────
app.get("/api/me", (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    return res.json({
      user: { id: payload.sub, email: payload.email, name: payload.name, picture: payload.picture },
    });
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// ── Auth helpers ─────────────────────────────────────────────────────────────

/** Sign a 30-day FitCheckr session JWT from a normalised user profile. */
function signSessionJwt(profile) {
  return jwt.sign(
    { sub: profile.id, email: profile.email, name: profile.name, picture: profile.picture || null },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

/** After a server-side OAuth callback, redirect to the Chrome extension. */
function redirectToExtension(res, extensionId, params) {
  const url = new URL(`https://${extensionId}.chromiumapp.org/`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  res.redirect(url.toString());
}

// ────────────────────────────────────────────────────────
// Google OAuth — server-side proxy
// Extension: chrome.identity.launchWebAuthFlow → /api/auth/google/start
// Flow: extension → start → accounts.google.com → callback → chromiumapp.org
//
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BACKEND_URL
// Google Cloud Console setup:
//   - Create OAuth 2.0 credential (Web application type)
//   - Add <BACKEND_URL>/api/auth/google/callback as authorised redirect URI
// ────────────────────────────────────────────────────────
app.get("/api/auth/google/start", (req, res) => {
  const extId = req.query.ext;
  if (!extId) return res.status(400).send("Missing ext parameter");
  if (!GOOGLE_CLIENT_ID) return res.status(503).send("Google OAuth not configured on server");

  const state = jwt.sign(
    { extId, nonce: crypto.randomBytes(8).toString("hex") },
    JWT_SECRET,
    { expiresIn: "10m" }
  );
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id",     GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri",  `${BACKEND_URL}/api/auth/google/callback`);
  authUrl.searchParams.set("scope",         "openid email profile");
  authUrl.searchParams.set("state",         state);
  authUrl.searchParams.set("prompt",        "select_account");
  res.redirect(authUrl.toString());
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  let statePayload;
  try { statePayload = jwt.verify(state, JWT_SECRET); }
  catch (_) { return res.status(400).send("Invalid or expired OAuth state"); }

  if (error) return redirectToExtension(res, statePayload.extId, { error });

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BACKEND_URL}/api/auth/google/callback`,
        grant_type:    "authorization_code",
      }),
    });
    const tokens = await tokenResp.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const profileResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResp.json();

    const token = signSessionJwt({ id: profile.sub, email: profile.email, name: profile.name, picture: profile.picture });
    console.log("[auth] Google sign-in (proxy):", profile.email);
    redirectToExtension(res, statePayload.extId, { token });
  } catch (err) {
    console.error("[auth] Google callback error:", err.message);
    redirectToExtension(res, statePayload.extId, { error: "authentication_failed" });
  }
});

// ────────────────────────────────────────────────────────
// Facebook OAuth — server-side proxy
// Required env vars: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, BACKEND_URL
// Facebook App Dashboard setup:
//   - Add <BACKEND_URL>/api/auth/facebook/callback as Valid OAuth Redirect URI
//   - email scope requires App Review before going live;
//     test with App Admins / Test Users while in development mode
// ────────────────────────────────────────────────────────
app.get("/api/auth/facebook/start", (req, res) => {
  const extId = req.query.ext;
  if (!extId) return res.status(400).send("Missing ext parameter");
  if (!FACEBOOK_APP_ID) return res.status(503).send("Facebook OAuth not configured on server");

  const state = jwt.sign(
    { extId, nonce: crypto.randomBytes(8).toString("hex") },
    JWT_SECRET,
    { expiresIn: "10m" }
  );
  const authUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  authUrl.searchParams.set("client_id",     FACEBOOK_APP_ID);
  authUrl.searchParams.set("redirect_uri",  `${BACKEND_URL}/api/auth/facebook/callback`);
  authUrl.searchParams.set("scope",         "email,public_profile");
  authUrl.searchParams.set("state",         state);
  authUrl.searchParams.set("response_type", "code");
  res.redirect(authUrl.toString());
});

app.get("/api/auth/facebook/callback", async (req, res) => {
  const { code, state, error } = req.query;
  let statePayload;
  try { statePayload = jwt.verify(state, JWT_SECRET); }
  catch (_) { return res.status(400).send("Invalid or expired OAuth state"); }

  if (error) return redirectToExtension(res, statePayload.extId, { error });

  try {
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id",     FACEBOOK_APP_ID);
    tokenUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri",  `${BACKEND_URL}/api/auth/facebook/callback`);
    tokenUrl.searchParams.set("code",          code);

    const tokenResp = await fetch(tokenUrl.toString());
    const tokens = await tokenResp.json();
    if (tokens.error) throw new Error(tokens.error.message);

    const profileUrl = `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${tokens.access_token}`;
    const profile = await (await fetch(profileUrl)).json();
    if (profile.error) throw new Error(profile.error.message);

    const token = signSessionJwt({
      id:      profile.id,
      email:   profile.email            || "",
      name:    profile.name             || "",
      picture: profile.picture?.data?.url || null,
    });
    console.log("[auth] Facebook sign-in (proxy):", profile.email || profile.name);
    redirectToExtension(res, statePayload.extId, { token });
  } catch (err) {
    console.error("[auth] Facebook callback error:", err.message);
    redirectToExtension(res, statePayload.extId, { error: "authentication_failed" });
  }
});

// ────────────────────────────────────────────────────────
// Email OTP — stateless (no database required)
// A 6-digit code is hashed and embedded in a short-lived JWT nonce_token.
//
// Required env vars: RESEND_API_KEY
//   Sign up at resend.com (free tier: 3k emails/month).
//   Without a verified domain, emails send from onboarding@resend.dev.
//   For production: verify your domain and update the `from` address.
//
// POST /api/auth/email/request  { email }           → { nonce_token }
// POST /api/auth/email/verify   { email, nonce_token, code } → { token, user }
// ────────────────────────────────────────────────────────
const OTP_EXPIRY_MIN = 15;

app.post("/api/auth/email/request", async (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  if (!RESEND_API_KEY) {
    return res.status(503).json({ error: "Email auth not configured on server" });
  }

  const code     = String(crypto.randomInt(100000, 999999));
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const nonceToken = jwt.sign({ email, codeHash }, JWT_SECRET, { expiresIn: `${OTP_EXPIRY_MIN}m` });

  try {
    const emailResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "FitCheckr <onboarding@resend.dev>",
        to:      email,
        subject: `${code} — your FitCheckr sign-in code`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:400px;margin:0 auto;padding:32px 24px;color:#1A1A1A">
            <p style="font-size:20px;font-weight:700;color:#C4653A;margin:0 0 4px">FitCheckr ✦</p>
            <p style="color:#7A7370;margin:0 0 28px;font-size:14px">Your sign-in code</p>
            <div style="font-size:40px;font-weight:700;letter-spacing:10px;padding:20px;background:#F7F5F3;border-radius:10px;text-align:center">${code}</div>
            <p style="color:#999;font-size:12px;margin:20px 0 0">Expires in ${OTP_EXPIRY_MIN} minutes. Do not share this code.</p>
          </div>`,
      }),
    });
    if (!emailResp.ok) {
      const body = await emailResp.json().catch(() => ({}));
      console.error("[auth] Resend error:", JSON.stringify(body));
      return res.status(500).json({ error: "Failed to send email. Please try again." });
    }
  } catch (err) {
    console.error("[auth] Email send error:", err.message);
    return res.status(500).json({ error: "Failed to send email. Please try again." });
  }

  console.log("[auth] OTP sent to:", email);
  return res.json({ nonce_token: nonceToken });
});

app.post("/api/auth/email/verify", async (req, res) => {
  const { email, nonce_token, code } = req.body || {};
  if (!email || !nonce_token || !code) {
    return res.status(400).json({ error: "email, nonce_token and code are all required" });
  }

  let nonce;
  try { nonce = jwt.verify(nonce_token, JWT_SECRET); }
  catch (_) { return res.status(401).json({ error: "Code has expired — please request a new one." }); }

  if (nonce.email !== email) {
    return res.status(401).json({ error: "Email mismatch." });
  }

  // Constant-time comparison to resist timing attacks
  const submittedHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
  const bufA = Buffer.from(nonce.codeHash,   "hex");
  const bufB = Buffer.from(submittedHash,     "hex");
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return res.status(401).json({ error: "Incorrect code. Please check your email and try again." });
  }

  const token = signSessionJwt({ id: `email:${email}`, email, name: email.split("@")[0], picture: null });
  console.log("[auth] Email sign-in:", email);
  return res.json({ token, user: { id: `email:${email}`, email, name: email.split("@")[0], picture: null } });
});

// ────────────────────────────────────────────────────────
// Cloud Wardrobe Sync  (requires SUPABASE_URL + SUPABASE_SERVICE_KEY)
//
// Supabase setup (one-time):
//   1. supabase.com → New project
//   2. SQL editor → run:
//        CREATE TABLE wardrobe_items (
//          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//          user_id    TEXT NOT NULL,
//          type       TEXT NOT NULL DEFAULT 'item',
//          name       TEXT,
//          brand      TEXT,
//          price      TEXT,
//          look_name  TEXT,
//          products   JSONB,
//          result_image_url TEXT,
//          product_url TEXT,
//          saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//          created_at TIMESTAMPTZ DEFAULT NOW()
//        );
//        CREATE INDEX idx_wardrobe_user_id ON wardrobe_items(user_id);
//   3. Storage → New bucket "wardrobe-results" (Public bucket ✓)
//   4. Render env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
// ────────────────────────────────────────────────────────

// Helper: upload a base64 data-URL to Supabase Storage, return public URL
async function uploadResultImage(userId, dataUrl) {
  if (!supabase || !dataUrl || !dataUrl.startsWith("data:")) return null;
  try {
    const [header, b64] = dataUrl.split(",");
    const mime   = (header.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    const ext    = mime.split("/")[1] || "jpg";
    const buffer = Buffer.from(b64, "base64");
    const path   = `${userId}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

    const { error } = await supabase.storage
      .from(WARDROBE_BUCKET)
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (error) { console.error("[wardrobe] Storage upload error:", error.message); return null; }

    const { data } = supabase.storage.from(WARDROBE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("[wardrobe] uploadResultImage error:", err.message);
    return null;
  }
}

// GET /api/wardrobe — fetch all wardrobe items for the authenticated user
app.get("/api/wardrobe", requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Wardrobe sync not configured on server" });

  const { data, error } = await supabase
    .from("wardrobe_items")
    .select("*")
    .eq("user_id", req.user.id)
    .order("saved_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

// POST /api/wardrobe — save a new wardrobe item (uploads image to Supabase Storage)
app.post("/api/wardrobe", requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Wardrobe sync not configured on server" });

  const { type, name, brand, price, look_name, products, result_image, product_url, saved_at } = req.body || {};
  if (!type) return res.status(400).json({ error: "type is required" });

  // Upload the result image to Supabase Storage
  const result_image_url = await uploadResultImage(req.user.id, result_image);

  const { data, error } = await supabase
    .from("wardrobe_items")
    .insert({
      user_id:          req.user.id,
      type:             type || "item",
      name:             name             || null,
      brand:            brand            || null,
      price:            price            || null,
      look_name:        look_name        || null,
      products:         products         || null,
      result_image_url: result_image_url || null,
      product_url:      product_url      || null,
      saved_at:         saved_at         || new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  console.log("[wardrobe] Saved item for:", req.user.email, "— id:", data.id);
  return res.json({ item: data });
});

// DELETE /api/wardrobe/:id — delete a wardrobe item (and its stored image)
app.delete("/api/wardrobe/:id", requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Wardrobe sync not configured on server" });

  // Fetch item to verify ownership and get image path
  const { data: existing, error: fetchErr } = await supabase
    .from("wardrobe_items")
    .select("id, user_id, result_image_url")
    .eq("id", req.params.id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: "Item not found" });
  if (existing.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

  // Remove from Storage
  if (existing.result_image_url && SUPABASE_URL && existing.result_image_url.includes(SUPABASE_URL)) {
    const storagePath = existing.result_image_url.split(`/${WARDROBE_BUCKET}/`)[1];
    if (storagePath) {
      await supabase.storage.from(WARDROBE_BUCKET).remove([storagePath]);
    }
  }

  const { error } = await supabase.from("wardrobe_items").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// PATCH /api/wardrobe/:id — rename a look
app.patch("/api/wardrobe/:id", requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Wardrobe sync not configured on server" });

  const { look_name } = req.body || {};
  if (!look_name) return res.status(400).json({ error: "look_name is required" });

  const { data, error } = await supabase
    .from("wardrobe_items")
    .update({ look_name })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)   // ensures ownership without a separate fetch
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Item not found or forbidden" });
  return res.json({ item: data });
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
        // Resize to max 1024px so the FASHN payload stays well under 10 MB
        const resized = await sharp(Buffer.from(garmentBuf))
          .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toBuffer();
        fashnGarmentImage = `data:image/jpeg;base64,${resized.toString("base64")}`;
        console.log("[garment] Resized to", resized.length, "bytes (was", garmentBuf.byteLength, ")");
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
          model_image:        resolvedModelImage,
          garment_image:      fashnGarmentImage,
          category,
          mode,
          segmentation_free:  true,
          garment_photo_type: "auto",
          output_format:      "jpeg",
          return_base64:      false,  // return CDN URL
        },
      }),
    });

    const fashnData = await fashnResp.json();

    if (!fashnResp.ok) {
      // Log the full body so Render logs always show the real FASHN reason
      console.error("FASHN /run error:", fashnResp.status, JSON.stringify(fashnData));
      const errMsg = fashnData.detail || fashnData.message
        || (Array.isArray(fashnData) && fashnData[0]?.msg)
        || JSON.stringify(fashnData);
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
// POST /api/size-recommendation — AI-powered size recommendation via Claude
// Body: { product_name, brand, description, sizes[], height, height_unit,
//         weight, weight_unit, reference }
// Returns: { size, confidence, reason }
// ────────────────────────────────────────────────────────
app.post("/api/size-recommendation", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  }

  const {
    product_name, brand, description, sizes = [],
    height, height_unit = "cm",
    weight, weight_unit = "kg",
    reference,
  } = req.body;

  if (!height || !weight) {
    return res.status(400).json({ error: "height and weight are required." });
  }

  const heightCm = height_unit === "ft"
    ? Math.round(parseFloat(height) * 30.48)
    : parseFloat(height);
  const weightKg = weight_unit === "lbs"
    ? Math.round(parseFloat(weight) * 0.453592)
    : parseFloat(weight);

  const referenceNote = reference
    ? `The user says they usually wear ${reference}.`
    : "No reference garment provided.";

  const sizesLine = sizes.length
    ? `Available sizes: ${sizes.join(", ")}`
    : "Available sizes: unknown (recommend a standard size like XS/S/M/L/XL based on measurements)";

  const prompt = `You are a clothing fit expert. Recommend the best size for this shopper.

Product: ${product_name || "Unknown"}${brand ? ` by ${brand}` : ""}
${description ? `Description: ${description}\n` : ""}${sizesLine}

Shopper stats:
- Height: ${heightCm} cm
- Weight: ${weightKg} kg
- ${referenceNote}

Reply in exactly this format (no other text):
Size: [best size, or "Between X and Y" if borderline]
Confidence: [High | Medium | Low]
Reason: [one clear sentence explaining the recommendation]`;

  try {
    const claudeResp = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: "POST",
      headers: {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5",
        max_tokens: 120,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      throw new Error(claudeData.error?.message || "Claude API error");
    }

    const text = claudeData.content?.[0]?.text || "";
    const sizeMatch       = text.match(/^Size:\s*(.+)$/m);
    const confidenceMatch = text.match(/^Confidence:\s*(High|Medium|Low)/im);
    const reasonMatch     = text.match(/^Reason:\s*(.+)$/m);

    if (!sizeMatch) {
      return res.status(500).json({ error: "Could not parse recommendation." });
    }

    return res.json({
      size:       sizeMatch[1].trim(),
      confidence: confidenceMatch?.[1] || "Medium",
      reason:     reasonMatch?.[1]?.trim() || "",
    });
  } catch (err) {
    console.error("size-recommendation error:", err.message);
    return res.status(500).json({ error: err.message });
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
