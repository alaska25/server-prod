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
    // Private book file location. Hidden from every query by default; code that
    // truly needs it must ask for it with .select("+fileKey") / "+fileUrl".
    fileUrl: { type: String, required: true, select: false },
    fileKey: { type: String, required: true, select: false },
    fileType: { type: String, enum: ["pdf", "epub"], required: true },
    // Optional "read sample" preview file, uploaded separately by an admin.
    sampleUrl: { type: String },
    sampleKey: { type: String },
    sampleFileType: { type: String, enum: ["pdf", "epub"] },
    // Optional metadata shown in the book details row on the frontend.
    pageCount: { type: Number, min: 0 },
    publishedAt: { type: Date },
    isFree: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    // Controls storefront visibility. Defaults to true for new books.
    published: { type: Boolean, default: true },
    avgRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// A free book always costs 0, whichever code path saved it.
bookSchema.pre("validate", function (next) {
  if (this.isFree) this.price = 0;
  next();
});

// Full-text search (title / author / category).
// (Left unchanged on purpose: a MongoDB collection can only have one text
// index, and changing its fields means dropping and rebuilding it.)
bookSchema.index({ title: "text", author: "text", category: "text" });

// Listing indexes: without these, every list request scans the whole
// collection and sorts it in memory.
bookSchema.index({ published: 1, createdAt: -1 });
bookSchema.index({ published: 1, category: 1, createdAt: -1 });
bookSchema.index({ published: 1, isFree: 1, createdAt: -1 });
bookSchema.index({ published: 1, featured: 1, createdAt: -1 });

export default mongoose.model("Book", bookSchema);