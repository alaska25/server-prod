import express from "express";
import {
  getTemplates,
  getTemplatesAdmin,
  getTemplateById,
  getTemplateAccess,
  getTemplateFileAdmin,
  uploadTemplateCover,
  uploadTemplateFile,
  claimFreeTemplate,
  getTemplateCategories,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "../controllers/templateController.js";
import { protect, admin } from "../middleware/auth.js";
import upload from "../middleware/upload.js";

const router = express.Router();

router.get("/", getTemplates);
router.get("/categories", getTemplateCategories);
router.get("/admin", protect, admin, getTemplatesAdmin);
router.get("/:id", getTemplateById);
router.get("/:id/access", protect, getTemplateAccess);
router.post("/:id/claim", protect, claimFreeTemplate);

router.post(
  "/:id/cover",
  protect,
  admin,
  upload.fields([{ name: "cover", maxCount: 1 }]),
  uploadTemplateCover
);
router.get("/:id/file", protect, admin, getTemplateFileAdmin);
router.post(
  "/:id/file",
  protect,
  admin,
  upload.fields([{ name: "templateFile", maxCount: 1 }]),
  uploadTemplateFile
);

router.post(
  "/",
  protect,
  admin,
  upload.fields([
    { name: "cover", maxCount: 1 },
    { name: "templateFile", maxCount: 1 },
  ]),
  createTemplate
);

router.put("/:id", protect, admin, updateTemplate);
router.delete("/:id", protect, admin, deleteTemplate);

export default router;