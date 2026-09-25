import express from "express";
import { protect, superAdmin } from "../middleware/auth.js";
import { getDashboardStats } from "../controllers/statsController.js";

const router = express.Router();

// Revenue and business figures are sensitive, so this stays superadmin-only,
// same tier as the Admins page.
router.get("/dashboard", protect, superAdmin, getDashboardStats);

export default router;