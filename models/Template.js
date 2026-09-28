import mongoose from "mongoose";

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    tagline: { type: String, trim: true },
    description: { type: String, required: true },
    category: { type: String, required: true, trim: true }, // e.g. "SaaS", "E-commerce", "Portfolio"
    techStack: [{ type: String, trim: true }], // e.g. ["MERN", "Stripe", "Tailwind"]
    version: { type: String, trim: true }, // e.g. "1.2.0"
    repoUrl: { type: String, trim: true }, // optional public preview repo, separate from the paid zip
    liveDemoUrl: { type: String, trim: true },
    price: { type: Number, required: true, min: 0 },
    isFree: { type: Boolean, default: false },
    coverUrl: { type: String, required: true },
    coverKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileType: { type: String, enum: ["zip"], default: "zip" },
    // Auto-extracted from the uploaded zip at upload time (see zipInspect.js)
    // so buyers can preview the project's structure and docs before purchase.
    readme: { type: String, default: "" },
    fileTree: { type: [String], default: [] },
    featured: { type: Boolean, default: false },
    // Controls storefront visibility, same convention as Book.published.
    published: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Full-text search.
templateSchema.index({ title: "text", category: "text", techStack: "text" });

// Listing indexes: without these, every list request scans the whole
// collection and sorts it in memory.
templateSchema.index({ published: 1, createdAt: -1 });
templateSchema.index({ published: 1, category: 1, createdAt: -1 });
templateSchema.index({ published: 1, isFree: 1, createdAt: -1 });

export default mongoose.model("Template", templateSchema);