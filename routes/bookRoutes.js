import express from "express";
import {
  getBooks,
  getBooksAdmin,
  getBookById,
  getBookByIdAdmin,
  getBookAccess,
  getBookSample,
  uploadBookSample,
  uploadBookCover,
  uploadBookFile,
  getBookFileAdmin,
  claimFreeBook,
  getCategories,
  createBook,
  updateBook,
  deleteBook,
} from "../controllers/bookController.js";
import { getReviews, createReview, updateReview, deleteReview } from "../controllers/reviewController.js";
import { protect, admin } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import Book from "../models/Book.js";

const router = express.Router();

// ---- Param validation: bad ids get a clean 404 instead of a 500 -----------
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
router.param("id", (req, res, next, id) =>
  OBJECT_ID.test(id) ? next() : res.status(404).json({ message: "Book not found" })
);
router.param("reviewId", (req, res, next, id) =>
  OBJECT_ID.test(id) ? next() : res.status(404).json({ message: "Review not found" })
);

// ---- Helpers --------------------------------------------------------------
const cachePublic = (seconds) => (req, res, next) => {
  res.set("Cache-Control", `public, max-age=${seconds}`);
  next();
};
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

// Checked BEFORE upload middleware, so a wrong book id doesn't leave an
// orphaned file behind in S3.
const bookExists = async (req, res, next) => {
  try {
    if (!(await Book.exists({ _id: req.params.id }))) {
      return res.status(404).json({ message: "Book not found" });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Per-endpoint limits (the general API limiter lives in server.js).
const sampleLimiter = makeLimiter(1, 30);
// Used after `protect`, so limits are per user, not per IP.
const writeLimiter = makeLimiter(1, 10, "Too many requests. Please try again later.", {
  keyGenerator: (req) => String(req.user._id),
});

// ---- Public catalog -------------------------------------------------------
router.get("/", cachePublic(60), getBooks);
router.get("/categories", cachePublic(300), getCategories);

// Must come before "/:id" or Express would treat "admin" as a book id.
router.get("/admin", protect, admin, noStore, getBooksAdmin);
router.get("/admin/:id", protect, admin, noStore, getBookByIdAdmin);

router.get("/:id", getBookById);
router.get("/:id/access", protect, noStore, getBookAccess);
router.post("/:id/claim", protect, writeLimiter, claimFreeBook);

// Public preview: no auth required, matches how the book detail page itself is public.
router.get("/:id/sample", sampleLimiter, getBookSample);
router.post(
  "/:id/sample",
  protect,
  admin,
  bookExists,
  upload.fields([{ name: "sampleFile", maxCount: 1 }]),
  uploadBookSample
);

// Replace an existing book's cover image or book file after creation.
router.post(
  "/:id/cover",
  protect,
  admin,
  bookExists,
  upload.fields([{ name: "cover", maxCount: 1 }]),
  uploadBookCover
);
// Admin download of the current book file (before replacing it).
router.get("/:id/file", protect, admin, noStore, getBookFileAdmin);
router.post(
  "/:id/file",
  protect,
  admin,
  bookExists,
  upload.fields([{ name: "bookFile", maxCount: 1 }]),
  uploadBookFile
);

// ---- Reviews --------------------------------------------------------------
// NOTE: reviewController.js still needs review (ownership checks on update /
// delete, verified-purchase rule, one review per user per book).
router.get("/:id/reviews", getReviews);
router.post("/:id/reviews", protect, writeLimiter, createReview);
router.put("/:id/reviews/:reviewId", protect, writeLimiter, updateReview);
router.delete("/:id/reviews/:reviewId", protect, writeLimiter, deleteReview);

// ---- Admin create / update / delete ---------------------------------------
router.post(
  "/",
  protect,
  admin,
  upload.fields([
    { name: "cover", maxCount: 1 },
    { name: "bookFile", maxCount: 1 },
    { name: "sampleFile", maxCount: 1 },
  ]),
  createBook
);

router.put("/:id", protect, admin, updateBook);
router.delete("/:id", protect, admin, deleteBook);

export default router;