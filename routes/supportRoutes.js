import express from "express";
import { sendChatMessage } from "../controllers/supportController.js";

const router = express.Router();

router.post("/chat", sendChatMessage);

export default router;