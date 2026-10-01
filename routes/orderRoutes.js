import express from "express";
import {
  createPaypalCheckout,
  capturePaypalCheckout,
  getMyOrders,
  getAllOrders,
} from "../controllers/orderController.js";
import { protect, admin } from "../middleware/auth.js";
import { makeLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// Payment endpoints call PayPal's API on every request, so limit them per
// user (this runs after `protect`).
const paymentLimiter = makeLimiter(1, 10, "Too many requests. Please try again later.", {
  keyGenerator: (req) => String(req.user._id),
});

// Order data is personal: never cache it.
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

router.post("/paypal/create-order", protect, paymentLimiter, createPaypalCheckout);
router.post("/paypal/capture-order", protect, paymentLimiter, capturePaypalCheckout);
router.get("/my", protect, noStore, getMyOrders);
router.get("/", protect, admin, noStore, getAllOrders);

export default router;