import express from "express";
import {
  createCheckoutSession,
  getMyOrders,
  getAllOrders,
} from "../controllers/orderController.js";
import { protect, admin } from "../middleware/auth.js";

const router = express.Router();

router.post("/checkout", protect, createCheckoutSession);
router.get("/my", protect, getMyOrders);
router.get("/", protect, admin, getAllOrders);

export default router;
