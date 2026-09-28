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
    pageCount: { type: Number, min: 0 },
    publishedAt: { type: Date },
    isFree: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    // Controls storefront visibility. Defaults to true so existing books
    // stay visible the moment this field is introduced.
    published: { type: Boolean, default: true },
    avgRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Full-text search (title / author / category).
bookSchema.index({ title: "text", author: "text", category: "text" });

// Listing indexes: without these, every list request scans the whole
// collection and sorts it in memory.
bookSchema.index({ published: 1, createdAt: -1 });
bookSchema.index({ published: 1, category: 1, createdAt: -1 });
bookSchema.index({ published: 1, isFree: 1, createdAt: -1 });

export default mongoose.model("Book", bookSchema);