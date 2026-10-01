import crypto from "crypto";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import sharp from "sharp";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../utils/s3.js";

const MB = 1024 * 1024;
const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;
const httpError = (message, status) => Object.assign(new Error(message), { status });

// Per-field rules. `image` fields are resized and converted to WebP;
// everything else is streamed to S3 unchanged.
//
// IMPORTANT: covers/ and photos/ are meant to be publicly readable.
// books/, samples/ and templates/ must NOT be public: they are only ever
// served through signed URLs (see bookController / templateController).
const RULES = {
  cover: { types: [".jpg", ".jpeg", ".png", ".webp"], folder: "covers", image: { width: 600, maxBytes: 10 * MB } },
  photo: { types: [".jpg", ".jpeg", ".png", ".webp"], folder: "photos", image: { width: 400, maxBytes: 5 * MB } },
  bookFile: { types: [".pdf", ".epub"], folder: "books" },
  sampleFile: { types: [".pdf", ".epub"], folder: "samples" },
  templateFile: { types: [".zip"], folder: "templates" },
};

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
};

const extOf = (file) => path.extname(file.originalname).toLowerCase();
const makeKey = (file, ext) => `${RULES[file.fieldname].folder}/${crypto.randomUUID()}${ext}`;

const fileFilter = (req, file, cb) => {
  const rule = RULES[file.fieldname];
  if (!rule) return cb(httpError(`Unexpected field: ${file.fieldname}`, 400));
  if (!rule.types.includes(extOf(file))) {
    return cb(httpError(`Unsupported file type for ${file.fieldname}`, 400));
  }
  cb(null, true);
};

// ---- Standard storage: streams the file straight to S3, unchanged --------
const passthroughStorage = multerS3({
  s3,
  bucket: process.env.S3_BUCKET,
  contentType: (req, file, cb) => cb(null, CONTENT_TYPES[extOf(file)] || "application/octet-stream"),
  key: (req, file, cb) => cb(null, makeKey(file, extOf(file))),
});

// ---- Image storage: size cap, resize + convert to WebP, then upload ------
const imageStorage = {
  _handleFile(req, file, cb) {
    const { width, maxBytes } = RULES[file.fieldname].image;
    const key = makeKey(file, ".webp");

    // multer must only be called back once, even if several things fail.
    let done = false;
    const finish = (err, info) => {
      if (!done) {
        done = true;
        cb(err, info);
      }
    };

    const resizer = sharp({ limitInputPixels: 40_000_000 })
      .rotate() // respect EXIF orientation (EXIF/GPS data is dropped on output)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 });

    let bytes = 0;
    file.stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        file.stream.unpipe(resizer);
        file.stream.resume(); // drain so the request doesn't hang
        resizer.destroy();
        finish(httpError("Image is too large", 413));
      }
    });
    file.stream.on("error", finish);
    resizer.on("error", finish);
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
            finish(null, {
              key,
              location: publicUrl(key),
              size: buffer.length,
              mimetype: "image/webp",
              bucket: process.env.S3_BUCKET,
            })
          )
      )
      .catch(finish);
  },

  _removeFile(req, file, cb) {
    s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: file.key }))
      .then(() => cb(null))
      .catch(cb);
  },
};

const pick = (file) => (RULES[file.fieldname]?.image ? imageStorage : passthroughStorage);

const upload = multer({
  fileFilter,
  storage: {
    _handleFile: (req, file, cb) => pick(file)._handleFile(req, file, cb),
    _removeFile: (req, file, cb) => pick(file)._removeFile(req, file, cb),
  },
  limits: {
    fileSize: 200 * MB, // ebooks can be large
    files: 3,
    fields: 25,
    fieldSize: 1 * MB,
    parts: 30,
  },
});

export default upload;