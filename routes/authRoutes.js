import express from "express";
import {
  registerUser,
  loginUser,
  getProfile,
  getMyLibrary,
  uploadUserPhoto,
} from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";
import upload from "../middleware/upload.js";

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/profile", protect, getProfile);
router.get("/library", protect, getMyLibrary);
router.post("/photo", protect, upload.fields([{ name: "photo", maxCount: 1 }]), uploadUserPhoto);

export default router;