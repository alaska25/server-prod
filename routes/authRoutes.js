import express from "express";
import { registerUser, loginUser, getProfile, getMyLibrary } from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/profile", protect, getProfile);
router.get("/library", protect, getMyLibrary);

export default router;
