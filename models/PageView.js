import mongoose from "mongoose";

// One row per page view. Anonymous: no name, email, IP address or cookie is
// stored. `visitor` is a one-way hash that changes every day, so it can count
// unique visitors for a day but cannot follow anyone from one day to the next.
const pageViewSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, maxlength: 200 },
    source: { type: String, default: "", maxlength: 100 }, // referring site or utm_source; "" = direct
    device: { type: String, enum: ["mobile", "desktop"], default: "desktop" },
    visitor: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Old rows are deleted automatically after about 14 months.
pageViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 425 });

export default mongoose.model("PageView", pageViewSchema);