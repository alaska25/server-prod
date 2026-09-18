import Book from "../models/Book.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { createPaypalOrder, capturePaypalOrder } from "../utils/paypal.js";

// POST /api/orders/paypal/create-order  { bookIds: [...] }
// Creates our own pending Order record, then creates a matching PayPal
// order and returns its id for the frontend PayPal buttons to use.
export const createPaypalCheckout = async (req, res) => {
  try {
    const { bookIds } = req.body;
    if (!Array.isArray(bookIds) || bookIds.length === 0) {
      return res.status(400).json({ message: "bookIds must be a non-empty array" });
    }

    const books = await Book.find({ _id: { $in: bookIds } });
    if (books.length !== bookIds.length) {
      return res.status(400).json({ message: "One or more books could not be found" });
    }

    const totalAmount = books.reduce((sum, b) => sum + b.price, 0);

    const order = await Order.create({
      user: req.user._id,
      books: books.map((b) => ({ book: b._id, price: b.price })),
      totalAmount,
      status: "pending",
    });

    const paypalOrderId = await createPaypalOrder(totalAmount, order._id.toString());

    order.paypalOrderId = paypalOrderId;
    await order.save();

    res.json({ paypalOrderId, orderId: order._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/orders/paypal/capture-order  { paypalOrderId }
// Called after the buyer approves payment in the PayPal popup. Captures
// the funds, marks our order paid, and adds the books to the user's library.
export const capturePaypalCheckout = async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    if (!paypalOrderId) {
      return res.status(400).json({ message: "paypalOrderId is required" });
    }

    const order = await Order.findOne({ paypalOrderId, user: req.user._id });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.status === "paid") {
      return res.json({ message: "Order already fulfilled", orderId: order._id });
    }

    const capture = await capturePaypalOrder(paypalOrderId);

    const captureStatus = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (capture.status !== "COMPLETED" || captureStatus !== "COMPLETED") {
      order.status = "failed";
      await order.save();
      return res.status(400).json({ message: "Payment was not completed" });
    }

    order.status = "paid";
    await order.save();

    const bookIds = order.books.map((b) => b.book);
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { library: { $each: bookIds } } });

    res.json({ message: "Payment captured", orderId: order._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/orders/my
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .populate("books.book", "title coverUrl")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/orders (admin)
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find({})
      .populate("user", "name email")
      .populate("books.book", "title")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};