import express from "express";
import { protect, superAdmin } from "../middleware/auth.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { getDashboardStats } from "../controllers/statsController.js";

const router = express.Router();

// The dashboard runs several database aggregations. The controller caches the
// result for 60 s, but this limit (per user, runs after `protect`) keeps a
// hammered endpoint from ever reaching the database.
const dashboardLimiter = makeLimiter(1, 30, "Too many requests. Please try again later.", {
  keyGenerator: (req) => String(req.user._id),
});

// Revenue and business figures are sensitive, so this stays superadmin-only,
// same tier as the Admins page.
router.get("/dashboard", protect, superAdmin, dashboardLimiter, getDashboardStats);

export default router;