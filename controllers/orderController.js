import Book from "../models/Book.js";
import Template from "../models/Template.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { createPaypalOrder, capturePaypalOrder } from "../utils/paypal.js";

// POST /api/orders/paypal/create-order  { bookIds: [...], templateIds: [...] }
// Either array may be omitted/empty; at least one item across both is required.
export const createPaypalCheckout = async (req, res) => {
  try {
    const bookIds = Array.isArray(req.body.bookIds) ? req.body.bookIds : [];
    const templateIds = Array.isArray(req.body.templateIds) ? req.body.templateIds : [];

    if (bookIds.length === 0 && templateIds.length === 0) {
      return res.status(400).json({ message: "Your cart is empty" });
    }

    const [books, templates] = await Promise.all([
      bookIds.length ? Book.find({ _id: { $in: bookIds } }) : [],
      templateIds.length ? Template.find({ _id: { $in: templateIds } }) : [],
    ]);

    if (books.length !== bookIds.length) {
      return res.status(400).json({ message: "One or more books could not be found" });
    }
    if (templates.length !== templateIds.length) {
      return res.status(400).json({ message: "One or more templates could not be found" });
    }

    const totalAmount =
      books.reduce((sum, b) => sum + b.price, 0) + templates.reduce((sum, t) => sum + t.price, 0);

    const order = await Order.create({
      user: req.user._id,
      books: books.map((b) => ({ book: b._id, price: b.price })),
      templates: templates.map((t) => ({ template: t._id, price: t.price })),
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
    const templateIds = order.templates.map((t) => t.template);

    const updates = {};
    if (bookIds.length) updates.library = { $each: bookIds };
    if (templateIds.length) updates.ownedTemplates = { $each: templateIds };

    if (Object.keys(updates).length) {
      const addToSet = {};
      for (const [field, value] of Object.entries(updates)) addToSet[field] = value;
      await User.findByIdAndUpdate(req.user._id, { $addToSet: addToSet });
    }

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
      .populate("templates.template", "title coverUrl")
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
      .populate("templates.template", "title")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};