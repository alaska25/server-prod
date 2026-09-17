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
    totalAmount: { type: Number, required: true },
    stripeSessionId: { type: String },
    stripePaymentIntentId: { type: String },
    status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
