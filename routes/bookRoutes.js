import express from "express";
import {
  getBooks,
  getBookById,
  getBookAccess,
  getBookSample,
  uploadBookSample,
  claimFreeBook,
  getCategories,
  createBook,
  updateBook,
  deleteBook,
} from "../controllers/bookController.js";
import { getReviews, createReview, updateReview, deleteReview } from "../controllers/reviewController.js";
import { protect, admin } from "../middleware/auth.js";
import upload from "../middleware/upload.js";

const router = express.Router();

router.get("/", getBooks);
router.get("/categories", getCategories);
router.get("/:id", getBookById);
router.get("/:id/access", protect, getBookAccess);
router.post("/:id/claim", protect, claimFreeBook);

// Public preview: no auth required, matches how the book detail page itself is public.
router.get("/:id/sample", getBookSample);
router.post(
  "/:id/sample",
  protect,
  admin,
  upload.fields([{ name: "sampleFile", maxCount: 1 }]),
  uploadBookSample
);

router.get("/:id/reviews", getReviews);
router.post("/:id/reviews", protect, createReview);
router.put("/:id/reviews/:reviewId", protect, updateReview);
router.delete("/:id/reviews/:reviewId", protect, deleteReview);

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