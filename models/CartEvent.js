import mongoose from "mongoose";

// One row each time a visitor adds a book or template to the cart. Anonymous:
// no account, IP address or cookie is stored. `visitor` is the same one-way,
// once-a-day hash used for page views. The title is copied from the database
// at that moment, never taken from the browser.
const cartEventSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["book", "template"], required: true },
    itemId: { type: String, required: true },
    title: { type: String, default: "", maxlength: 200 },
    price: { type: Number, default: 0, min: 0 },
    visitor: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Old rows are deleted automatically after about 14 months.
cartEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 425 });

export default mongoose.model("CartEvent", cartEventSchema);