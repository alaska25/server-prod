import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import sharp from "sharp";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../utils/s3.js";

const ALLOWED_COVER_TYPES = [".jpg", ".jpeg", ".png", ".webp"];
const ALLOWED_BOOK_TYPES = [".pdf", ".epub"];
const ALLOWED_TEMPLATE_TYPES = [".zip"];

// Covers are resized to at most this width (height follows the aspect ratio).
// 600px is plenty for a 2:3 book card, even on retina screens.
const COVER_MAX_WIDTH = 600;
const COVER_WEBP_QUALITY = 80;

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === "cover" && ALLOWED_COVER_TYPES.includes(ext)) {
    return cb(null, true);
  }
  if (file.fieldname === "bookFile" && ALLOWED_BOOK_TYPES.includes(ext)) {
    return cb(null, true);
  }
  // Sample files use the same allowed types as the main book file
  // (bookController treats a sample's extension as "epub" or "pdf").
  if (file.fieldname === "sampleFile" && ALLOWED_BOOK_TYPES.includes(ext)) {
    return cb(null, true);
  }
  if (file.fieldname === "templateFile" && ALLOWED_TEMPLATE_TYPES.includes(ext)) {
    return cb(null, true);
  }
  cb(new Error(`Unsupported file type for ${file.fieldname}: ${ext}`));
};

const makeKey = (file, ext) => {
  const folder =
    file.fieldname === "cover"
      ? "covers"
      : file.fieldname === "sampleFile"
      ? "samples"
      : file.fieldname === "templateFile"
      ? "templates"
      : "books";
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${folder}/${unique}${ext}`;
};

// ---- Standard storage: streams the file straight to S3, unchanged --------
const passthroughStorage = multerS3({
  s3,
  bucket: process.env.S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    cb(null, makeKey(file, path.extname(file.originalname)));
  },
});

// ---- Cover storage: resize + convert to WebP, then upload ----------------
// Custom multer storage engine. It sets `key`, `location` and `size` on the
// file object, the same fields bookController already reads.
const coverStorage = {
  _handleFile(req, file, cb) {
    const key = makeKey(file, ".webp");

    const resizer = sharp()
      .rotate() // respect the photo's EXIF orientation
      .resize({ width: COVER_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: COVER_WEBP_QUALITY });

    file.stream.on("error", cb);
    resizer.on("error", cb);

    file.stream.pipe(resizer);

    resizer
      .toBuffer()
      .then((buffer) =>
        s3
          .send(
            new PutObjectCommand({
              Bucket: process.env.S3_BUCKET,
              Key: key,
              Body: buffer,
              ContentType: "image/webp",
              // Keys are unique per upload, so browsers/CDNs can cache forever.
              CacheControl: "public, max-age=31536000, immutable",
            })
          )
          .then(() =>
            cb(null, {
              key,
              location: publicUrl(key),
              size: buffer.length,
              mimetype: "image/webp",
              bucket: process.env.S3_BUCKET,
            })
          )
      )
      .catch(cb);
  },

  _removeFile(req, file, cb) {
    // Called by multer if a later step fails; clean up the uploaded object.
    s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: file.key }))
      .then(() => cb(null))
      .catch(cb);
  },
};

// ---- Router: covers -> resize; everything else -> untouched --------------
const storage = {
  _handleFile(req, file, cb) {
    if (file.fieldname === "cover") return coverStorage._handleFile(req, file, cb);
    return passthroughStorage._handleFile(req, file, cb);
  },
  _removeFile(req, file, cb) {
    if (file.fieldname === "cover") return coverStorage._removeFile(req, file, cb);
    return passthroughStorage._removeFile(req, file, cb);
  },
};

const upload = multer({
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max (ebooks can be large)
  storage,
});

export default upload;