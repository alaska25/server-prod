import express from "express";
import {
  createPaypalCheckout,
  capturePaypalCheckout,
  getMyOrders,
  getAllOrders,
} from "../controllers/orderController.js";
import { protect, admin } from "../middleware/auth.js";

const router = express.Router();

router.post("/paypal/create-order", protect, createPaypalCheckout);
router.post("/paypal/capture-order", protect, capturePaypalCheckout);
router.get("/my", protect, getMyOrders);
router.get("/", protect, admin, getAllOrders);

export default router;