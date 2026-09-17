import mongoose from "mongoose";

const bookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    author: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    coverUrl: { type: String, required: true },
    coverKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileType: { type: String, enum: ["pdf", "epub"], required: true },
    isFree: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    avgRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bookSchema.index({ title: "text", author: "text", category: "text" });

export default mongoose.model("Book", bookSchema);
