import express from "express";
import { protect, superAdmin } from "../middleware/auth.js";
import {
  getAdmins,
  getCustomers,
  updateUserRole,
  updateUserStatus,
} from "../controllers/userController.js";

const router = express.Router();

// Admin management: superadmin-only.
router.get("/admins", protect, superAdmin, getAdmins);
router.put("/:id/role", protect, superAdmin, updateUserRole);
router.put("/:id/status", protect, superAdmin, updateUserStatus);

// Customer list: superadmin-only for now (change to allow "admin" too
// if support/day-to-day staff need to look up customers).
router.get("/customers", protect, superAdmin, getCustomers);

export default router;