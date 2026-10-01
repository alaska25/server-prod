import express from "express";
import { protect, superAdmin } from "../middleware/auth.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import {
  getAdmins,
  getCustomers,
  updateUserRole,
  updateUserStatus,
} from "../controllers/userController.js";

const router = express.Router();

// Bad ids get a clean 404 instead of a 500.
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
router.param("id", (req, res, next, id) =>
  OBJECT_ID.test(id) ? next() : res.status(404).json({ message: "User not found" })
);

// These lists contain personal data: never cache them.
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

// Per-user limit on privilege changes (runs after `protect`).
const changeLimiter = makeLimiter(1, 20, "Too many changes. Please try again later.", {
  keyGenerator: (req) => String(req.user._id),
});

// Admin management: superadmin-only.
router.get("/admins", protect, superAdmin, noStore, getAdmins);
router.put("/:id/role", protect, superAdmin, changeLimiter, updateUserRole);
router.put("/:id/status", protect, superAdmin, changeLimiter, updateUserStatus);

// Customer list: superadmin-only for now (change to allow "admin" too
// if support/day-to-day staff need to look up customers).
router.get("/customers", protect, superAdmin, noStore, getCustomers);

export default router;