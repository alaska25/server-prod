import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    books: [
      {
        book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
        price: { type: Number, required: true },
      },
    ],
    templates: [
      {
        template: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true },
        price: { type: Number, required: true },
      },
    ],
    totalAmount: { type: Number, required: true },
    paypalOrderId: { type: String },
    stripeSessionId: { type: String }, // kept for any pre-migration orders; unused going forward
    stripePaymentIntentId: { type: String }, // kept for any pre-migration orders; unused going forward
    status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
  },
  { timestamps: true }
);

// Dashboard stats aggregations (statsController.js) all filter on status,
// and several also filter/sort by createdAt — without these, every one of
// those queries does a full collection scan.
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ status: 1 });

export default mongoose.model("Order", orderSchema);