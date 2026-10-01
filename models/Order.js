import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    books: [
      {
        book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
        // Snapshot at purchase time, so order history still reads correctly
        // after a book is renamed or removed.
        title: { type: String },
        coverUrl: { type: String },
        price: { type: Number, required: true, min: 0 },
      },
    ],
    templates: [
      {
        template: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true },
        title: { type: String },
        coverUrl: { type: String },
        price: { type: Number, required: true, min: 0 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USD" },
    paypalOrderId: { type: String },
    paypalCaptureId: { type: String },
    paidAt: { type: Date },
    stripeSessionId: { type: String }, // legacy: pre-migration orders only
    stripePaymentIntentId: { type: String }, // legacy: pre-migration orders only
    status: {
      type: String,
      // pending_review: PayPal capture is PENDING (payment under review)
      // needs_review:   captured amount/currency did not match; check manually
      enum: ["pending", "pending_review", "needs_review", "paid", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

// One PayPal order / capture can only ever belong to one Order.
// sparse: these fields are absent until PayPal returns them.
orderSchema.index({ paypalOrderId: 1 }, { unique: true, sparse: true });
orderSchema.index({ paypalCaptureId: 1 }, { unique: true, sparse: true });
orderSchema.index({ user: 1, createdAt: -1 }); // getMyOrders
orderSchema.index({ status: 1, createdAt: -1 }); // dashboard stats + stale-pending cleanup

export default mongoose.model("Order", orderSchema);