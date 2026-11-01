import crypto from "crypto";
import PageView from "../models/PageView.js";

// Crawlers and tools are not visitors.
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|curl|wget|python|axios|node-fetch|go-http/i;

// Hostnames of this site itself, so a click from one of our own pages is not
// counted as a "source".
const OWN_HOSTS = (process.env.CLIENT_URL || "")
  .split(",")
  .map((s) => {
    try {
      return new URL(s.trim()).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })
  .filter(Boolean);

const today = () => new Date().toISOString().slice(0, 10);

// POST /api/traffic/collect  { path, referrer?, utm? }  (public)
// Always answers 204 quickly: a failure here must never affect a visitor.
export const collectPageView = async (req, res) => {
  try {
    const ua = String(req.get("user-agent") || "");
    if (!ua || BOT.test(ua) || req.get("dnt") === "1") return res.status(204).end();

    const { path, referrer, utm } = req.body || {};
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 200) {
      return res.status(204).end();
    }
    const cleanPath = path.split("?")[0].split("#")[0] || "/";
    if (cleanPath.startsWith("/admin")) return res.status(204).end();

    let source = "";
    if (typeof utm === "string" && utm) {
      source = utm.slice(0, 60).toLowerCase();
    } else if (typeof referrer === "string" && referrer) {
      try {
        const host = new URL(referrer).hostname.replace(/^www\./, "");
        if (host && !OWN_HOSTS.includes(host)) source = host.slice(0, 100);
      } catch {
        /* not a valid URL: treat as direct */
      }
    }

    // A different value every day, so a person cannot be followed across days.
    const visitor = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(`${today()}|${req.ip}|${ua}`)
      .digest("hex")
      .slice(0, 16);

    await PageView.create({
      path: cleanPath,
      source,
      device: /mobi|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop",
      visitor,
    });
    res.status(204).end();
  } catch (err) {
    console.error("collectPageView:", err.message);
    res.status(204).end();
  }
};