import multer from "multer";
import path from "path";

const ALLOWED_COVER_TYPES = [".jpg", ".jpeg", ".png", ".webp"];
const ALLOWED_TEMPLATE_TYPES = [".zip"];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === "cover" && ALLOWED_COVER_TYPES.includes(ext)) {
    return cb(null, true);
  }
  if (file.fieldname === "templateFile" && ALLOWED_TEMPLATE_TYPES.includes(ext)) {
    return cb(null, true);
  }
  cb(new Error(`Unsupported file type for ${file.fieldname}: ${ext}`));
};

// Memory storage (not multer-s3): we need the raw zip buffer in the
// controller to extract the README and file tree before uploading to S3.
const uploadTemplateMemory = multer({
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  storage: multer.memoryStorage(),
});

export default uploadTemplateMemory;