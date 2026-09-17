import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// One review per user per book
reviewSchema.index({ book: 1, user: 1 }, { unique: true });

export default mongoose.model("Review", reviewSchema);
