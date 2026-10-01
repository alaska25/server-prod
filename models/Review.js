import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: { validator: Number.isInteger, message: "Rating must be a whole number" },
    },
    comment: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// One review per user per book. This unique index is what makes the
// duplicate-review check safe when two requests arrive at the same time.
reviewSchema.index({ book: 1, user: 1 }, { unique: true });

// getReviews: filter by book, newest first (avoids an in-memory sort).
reviewSchema.index({ book: 1, createdAt: -1 });

export default mongoose.model("Review", reviewSchema);