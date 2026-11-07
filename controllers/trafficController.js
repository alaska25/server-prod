import crypto from "crypto";
import PageView from "../models/PageView.js";
import CartEvent from "../models/CartEvent.js";
import Book from "../models/Book.js";
import Template from "../models/Template.js";

// Country lookup from the visitor's IP address, done on the server with a
// built-in table (nothing is sent to another company). Only the 2-letter
// country code is saved, never the IP. If the package is not installed the
// server still runs; countries then come only from the host's own headers.
let geo = null;
try {
  geo = (await import("geoip-country")).default;
} catch {
  console.warn("geoip-country is not installed: run `npm install geoip-country` to record countries.");
}

// Prefer the country the host/CDN already worked out, then look the IP up.
const countryOf = (req, ip) => {
  const header = (req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1") return header;
  try {
    return geo?.lookup(ip)?.country || "";
  } catch {
    return "";
  }
};

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

// Always answers 204. The X-Traffic header says what happened, so a skipped
// visit can be explained from the browser's Network tab (look under the
// request's Response Headers). It is never shown to visitors.
const done = (res, why) => {
  res.set("X-Traffic", why);
  return res.status(204).end();
};

// POST /api/traffic/collect  { path, referrer?, utm? }  (public)
// Always answers 204 quickly: a failure here must never affect a visitor.
export const collectPageView = async (req, res) => {
  try {
    const ua = String(req.get("user-agent") || "");
    if (!ua) return done(res, "skipped:no-user-agent");
    if (BOT.test(ua)) return done(res, "skipped:bot");
    if (req.get("dnt") === "1") return done(res, "skipped:do-not-track");

    const { path, referrer, utm } = req.body || {};
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 200) {
      return done(res, "skipped:bad-path");
    }
    const cleanPath = path.split("?")[0].split("#")[0] || "/";
    if (cleanPath.startsWith("/admin")) return done(res, "skipped:admin-page");

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

    // The real visitor address: some hosts put their own proxy's address in
    // req.ip and the visitor's in this header.
    const ip = req.get("cf-connecting-ip") || req.ip;
    const country = countryOf(req, ip);

    // A different value every day, so a person cannot be followed across days.
    const visitor = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(`${today()}|${ip}|${ua}`)
      .digest("hex")
      .slice(0, 16);

    await PageView.create({
      path: cleanPath,
      source,
      country,
      device: /mobi|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop",
      visitor,
    });
    done(res, `recorded:${country || "unknown"}`);
  } catch (err) {
    console.error("collectPageView:", err.message);
    done(res, "error");
  }
};

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// POST /api/traffic/cart  { itemId, kind: "book" | "template" }  (public)
// Records that a visitor added something to the cart. The title and price are
// read from the database, so nothing the browser sends can be shown as fact.
export const collectCartAdd = async (req, res) => {
  try {
    const ua = String(req.get("user-agent") || "");
    if (!ua) return done(res, "skipped:no-user-agent");
    if (BOT.test(ua)) return done(res, "skipped:bot");
    if (req.get("dnt") === "1") return done(res, "skipped:do-not-track");

    const { itemId, kind } = req.body || {};
    if (!["book", "template"].includes(kind) || typeof itemId !== "string" || !OBJECT_ID.test(itemId)) {
      return done(res, "skipped:bad-item");
    }

    const Model = kind === "book" ? Book : Template;
    const item = await Model.findById(itemId).select("title price isFree").lean();
    if (!item) return done(res, "skipped:unknown-item");

    const ip = req.get("cf-connecting-ip") || req.ip;
    const visitor = crypto
      .createHmac("sha256", process.env.JWT_SECRET)
      .update(`${today()}|${ip}|${ua}`)
      .digest("hex")
      .slice(0, 16);

    await CartEvent.create({
      kind,
      itemId,
      title: item.title,
      price: item.isFree ? 0 : Number(item.price) || 0,
      visitor,
    });
    done(res, "recorded");
  } catch (err) {
    console.error("collectCartAdd:", err.message);
    done(res, "error");
  }
};