import "./config/env.js"; // must be first: loads .env before any other import runs
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import mongoose from "mongoose";
import multer from "multer";
import connectDB from "./config/db.js";
import { emailConfigError } from "./utils/sendEmail.js";
import { makeLimiter } from "./middleware/rateLimit.js";
import authRoutes from "./routes/authRoutes.js";
import bookRoutes from "./routes/bookRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import supportRoutes from "./routes/supportRoutes.js";
import newsletterRoutes from "./routes/newsletterRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import statsRoutes from "./routes/statsRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";

// ---- Fail fast on missing configuration ----------------------------------
// TODO: also add any email/SMTP variables used by utils/sendEmail.js.
const REQUIRED_ENV = [
  "MONGO_URI",
  "JWT_SECRET",
  "CLIENT_URL",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PUBLIC_URL_BASE",
  "GOOGLE_CLIENT_ID",
  "TURNSTILE_SECRET_KEY",
  "PAYPAL_MODE",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET must be at least 32 characters in production.");
  process.exit(1);
}

// Password-reset emails depend on this, and the reset endpoint hides sending
// failures on purpose, so a missing setup must stop the app instead.
if (emailConfigError) {
  if (process.env.NODE_ENV === "production") {
    console.error(`Email setup problem: ${emailConfigError}`);
    process.exit(1);
  }
  console.warn(`Email not configured (${emailConfigError}). Emails will be printed to the console.`);
}

const app = express();

app.disable("x-powered-by");
// Number of reverse proxies in front of the app (Vercel/nginx/host load
// balancer). Needed so rate limiting sees real client IPs. Adjust if needed.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());

// CLIENT_URL may hold several origins, comma separated
// (e.g. "https://example.com,https://www.example.com").
const allowedOrigins = process.env.CLIENT_URL.split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(Object.assign(new Error("Not allowed by CORS"), { status: 403 }));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "db_unavailable" });
});

// General limiter for the whole API. Stricter per-route limiters live in the
// route files (auth, samples, payments, reviews).
app.use("/api", makeLimiter(1, 300));

app.use("/api/auth", authRoutes);
app.use("/api/books", bookRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/users", userRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/templates", templateRoutes);

app.use((req, res) => res.status(404).json({ message: "Not found" }));

// Central error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res
      .status(tooBig ? 413 : 400)
      .json({ message: tooBig ? "File is too large" : "Invalid upload" });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err.stack || err);
  // Never leak internal error details on 5xx.
  res.status(status).json({ message: status < 500 ? err.message : "Server error" });
});

// ---- Start: connect to the database first, then listen -------------------
const PORT = process.env.PORT || 5000;
let server;

try {
  await connectDB(); // connectDB must throw on failure (not swallow the error)
  server = app.listen(PORT, () => console.log(`Adyoolau API running on port ${PORT}`));
} catch (err) {
  console.error("Startup failed:", err.message);
  process.exit(1);
}

// ---- Graceful shutdown ----------------------------------------------------
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    try {
      await mongoose.connection.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));