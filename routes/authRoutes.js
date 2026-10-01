import express from "express";
import {
  registerUser,
  loginUser,
  googleAuth,
  forgotPassword,
  resetPassword,
  getProfile,
  getMyLibrary,
  uploadUserPhoto,
} from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { makeLimiter } from "../middleware/rateLimit.js";

// ---- Rate limits ----------------------------------------------------------
// Applied per route (NOT on the whole /api/auth path), because /profile and
// /library are called constantly by logged-in users.
// Requires app.set("trust proxy", N) in server.js when behind a proxy.
const TOO_MANY = "Too many attempts. Please try again later.";

// Second key per email address, so attackers can't just rotate IPs.
const emailKey = (req) =>
  typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "no-email";

// skipSuccessfulRequests: only failed logins count toward the limit.
const loginIpLimiter = makeLimiter(15, 30, TOO_MANY, { skipSuccessfulRequests: true });
const loginEmailLimiter = makeLimiter(15, 8, TOO_MANY, {
  skipSuccessfulRequests: true,
  keyGenerator: emailKey,
});
const registerLimiter = makeLimiter(60, 10, TOO_MANY);
const googleLimiter = makeLimiter(15, 30, TOO_MANY);
const forgotIpLimiter = makeLimiter(15, 5, TOO_MANY);
const forgotEmailLimiter = makeLimiter(60, 3, TOO_MANY, { keyGenerator: emailKey });
const resetLimiter = makeLimiter(15, 10, TOO_MANY);
// Runs after `protect`, so it is per user.
const photoLimiter = makeLimiter(60, 10, "Too many uploads. Please try again later.", {
  keyGenerator: (req) => String(req.user._id),
});

const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

const router = express.Router();

router.post("/register", registerLimiter, registerUser);
router.post("/login", loginIpLimiter, loginEmailLimiter, loginUser);
router.post("/google", googleLimiter, googleAuth);
router.post("/forgot-password", forgotIpLimiter, forgotEmailLimiter, forgotPassword);
router.post("/reset-password", resetLimiter, resetPassword);
router.get("/profile", protect, noStore, getProfile);
router.get("/library", protect, noStore, getMyLibrary);
router.post(
  "/photo",
  protect,
  photoLimiter,
  upload.fields([{ name: "photo", maxCount: 1 }]),
  uploadUserPhoto
);

export default router;