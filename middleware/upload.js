import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import s3 from "../utils/s3.js";

const ALLOWED_COVER_TYPES = [".jpg", ".jpeg", ".png", ".webp"];
const ALLOWED_BOOK_TYPES = [".pdf", ".epub"];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === "cover" && ALLOWED_COVER_TYPES.includes(ext)) {
    return cb(null, true);
  }
  if (file.fieldname === "bookFile" && ALLOWED_BOOK_TYPES.includes(ext)) {
    return cb(null, true);
  }
  cb(new Error(`Unsupported file type for ${file.fieldname}: ${ext}`));
};

const upload = multer({
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max (ebooks can be large)
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const folder = file.fieldname === "cover" ? "covers" : "books";
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${folder}/${unique}${ext}`);
    },
  }),
});

export default upload;
