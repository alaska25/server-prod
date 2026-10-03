import mongoose from "mongoose";
import bcrypt from "bcryptjs"; // ASSUMPTION: use "bcrypt" if that is what your backend uses
import User from "../models/User.js";
import Order from "../models/Order.js";

// Avatar upload is NOT here: your existing POST /auth/photo already does it.

// Works whether your auth middleware sets req.user to a document or to { id }.
const uid = (req) => String(req.user._id || req.user.id);

// Express 4 does not catch errors from async handlers, so wrap each one.
const safe = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("[account]", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  });

/* ---------------------------- profile ---------------------------- */

export const getMe = safe(async (req, res) => {
  const user = await User.findById(uid(req)).select("+password").lean();
  if (!user) return res.status(404).json({ message: "Account not found." });
  // hasPassword is false for accounts that only use Google sign-in.
  res.json({ _id: user._id, name: user.name || "", email: user.email, hasPassword: Boolean(user.password) });
});

export const updateProfile = safe(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name.length < 1 || name.length > 80) {
    return res.status(400).json({ message: "Name must be between 1 and 80 characters." });
  }
  const user = await User.findByIdAndUpdate(uid(req), { $set: { name } }, { new: true }).lean();
  res.json({ name: user.name });
});

export const changePassword = safe(async (req, res) => {
  const { currentPassword = "", newPassword = "" } = req.body;
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ message: "New password must be 8 to 128 characters." });
  }
  const user = await User.findById(uid(req)).select("+password");
  if (!user?.password) {
    return res.status(400).json({ message: "This account signs in with Google, so it has no password to change." });
  }
  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) return res.status(400).json({ message: "Current password is incorrect." });

  // updateOne skips any pre-save hook, so the password is hashed exactly once (here).
  // If your login compares with bcrypt, this is compatible.
  const hash = await bcrypt.hash(newPassword, 12);
  await User.updateOne({ _id: user._id }, { $set: { password: hash } });
  res.json({ message: "Password updated." });
});

/* ----------------------- orders and receipts ---------------------- */

// Uses the title/price snapshots saved on each order, so deleted items still show.
const toOrder = (o) => ({
  _id: o._id,
  receiptNo: String(o._id).slice(-8).toUpperCase(),
  createdAt: o.paidAt || o.createdAt,
  status: o.status,
  totalAmount: o.totalAmount,
  currency: o.currency || "USD",
  items: [
    ...(o.books || []).map((b) => ({ kind: "book", title: b.title || "Ebook", coverUrl: b.coverUrl || "", price: b.price })),
    ...(o.templates || []).map((t) => ({ kind: "template", title: t.title || "Template", coverUrl: t.coverUrl || "", price: t.price })),
  ],
});

const PAID = ["paid", "pending_review"];

export const getMyOrders = safe(async (req, res) => {
  const orders = await Order.find({ user: uid(req), status: { $in: PAID } })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(orders.map(toOrder));
});

export const getReceipt = safe(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Receipt not found." });
  // Filtering by user means nobody can read another customer's receipt.
  const order = await Order.findOne({ _id: req.params.id, user: uid(req), status: { $in: PAID } }).lean();
  if (!order) return res.status(404).json({ message: "Receipt not found." });
  const buyer = await User.findById(uid(req)).select("name email").lean();
  res.json({
    ...toOrder(order),
    paymentMethod: "PayPal",
    transactionId: order.paypalCaptureId || order.paypalOrderId || "",
    billedTo: { name: buyer?.name || "", email: buyer?.email || "" },
  });
});