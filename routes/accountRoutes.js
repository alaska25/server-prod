import { Router } from "express";
// ASSUMPTION: adjust this import to your real auth middleware (it must set req.user).
import { protect } from "../middleware/auth.js";
import {
  getMe,
  updateProfile,
  changePassword,
  handleAvatarUpload,
  uploadAvatar,
  removeAvatar,
  getMyOrders,
  getReceipt,
} from "../controllers/accountController.js";

const router = Router();
router.use(protect);

router.get("/me", getMe);
router.patch("/profile", updateProfile);
router.post("/password", changePassword);
router.post("/avatar", handleAvatarUpload, uploadAvatar);
router.delete("/avatar", removeAvatar);
router.get("/orders", getMyOrders);
router.get("/orders/:id/receipt", getReceipt);

export default router;
