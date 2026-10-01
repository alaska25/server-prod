import mongoose from "mongoose";

// Links must be http(s) (blocks javascript: URLs). Empty is allowed.
const HTTP_URL = /^https?:\/\/\S+$/i;

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    tagline: { type: String, trim: true, maxlength: 300 },
    description: { type: String, required: true, maxlength: 20000 },
    category: { type: String, required: true, trim: true, maxlength: 100 }, // e.g. "SaaS", "E-commerce", "Portfolio"
    techStack: {
      type: [{ type: String, trim: true, maxlength: 50 }], // e.g. ["MERN", "Stripe", "Tailwind"]
      validate: { validator: (v) => v.length <= 30, message: "Too many tech stack entries (max 30)" },
    },
    version: { type: String, trim: true, maxlength: 50 }, // e.g. "1.2.0"
    repoUrl: { type: String, trim: true, maxlength: 500, match: [HTTP_URL, "repoUrl must be an http(s) link"] }, // optional public preview repo, separate from the paid zip
    liveDemoUrl: { type: String, trim: true, maxlength: 500, match: [HTTP_URL, "liveDemoUrl must be an http(s) link"] },
    price: { type: Number, required: true, min: 0 },
    isFree: { type: Boolean, default: false },
    coverUrl: { type: String, required: true },
    coverKey: { type: String, required: true },
    // Private zip location. Hidden from every query by default; code that truly
    // needs it must ask for it with .select("+fileKey") / "+fileUrl".
    fileUrl: { type: String, required: true, select: false },
    fileKey: { type: String, required: true, select: false },
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

// A free template always costs 0, whichever code path saved it.
templateSchema.pre("validate", function () {
  if (this.isFree) this.price = 0;
});

// Full-text search.
// (Left unchanged on purpose: a MongoDB collection can only have one text
// index, and changing its fields means dropping and rebuilding it.)
templateSchema.index({ title: "text", category: "text", techStack: "text" });

// Listing indexes: without these, every list request scans the whole
// collection and sorts it in memory.
templateSchema.index({ published: 1, createdAt: -1 });
templateSchema.index({ published: 1, category: 1, createdAt: -1 });
templateSchema.index({ published: 1, isFree: 1, createdAt: -1 });
templateSchema.index({ published: 1, featured: 1, createdAt: -1 });

export default mongoose.model("Template", templateSchema);