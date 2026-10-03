import { Router } from "express";
// Your real middleware (exports protect, admin, superAdmin).
import { protect } from "../middleware/auth.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { getMe, updateProfile, changePassword, getMyOrders, getReceipt } from "../controllers/accountController.js";

const router = Router();
router.use(protect);

// Slows down password guessing on a stolen session: 10 attempts per 15 minutes.
// ASSUMPTION: makeLimiter(windowMinutes, maxRequests), as in makeLimiter(1, 300) in your server file.
const passwordLimiter = makeLimiter(15, 10);

router.get("/me", getMe);
router.patch("/profile", updateProfile);
router.post("/password", passwordLimiter, changePassword);
router.get("/orders", getMyOrders);
router.get("/orders/:id/receipt", getReceipt);

export default router;