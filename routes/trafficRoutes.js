import express from "express";
import { collectPageView, collectCartAdd } from "../controllers/trafficController.js";
import { makeLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// Public (visitors are not logged in), but limited per IP.
router.post("/collect", makeLimiter(1, 60), collectPageView);
router.post("/cart", makeLimiter(1, 60), collectCartAdd);

export default router;