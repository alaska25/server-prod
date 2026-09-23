import mongoose from "mongoose";

const bookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true },
    author: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    coverUrl: { type: String, required: true },
    coverKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileType: { type: String, enum: ["pdf", "epub"], required: true },
    // Optional "read sample" preview file, uploaded separately by an admin.
    // Not required, so existing books without a sample keep working fine.
    sampleUrl: { type: String },
    sampleKey: { type: String },
    sampleFileType: { type: String, enum: ["pdf", "epub"] },
    // Optional metadata shown in the book details row on the frontend.
    // Not required, so existing books without this data keep working fine.
    pageCount: { type: Number, min: 0 },
    publishedAt: { type: Date },
    isFree: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    avgRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bookSchema.index({ title: "text", author: "text", category: "text" });

export default mongoose.model("Book", bookSchema);