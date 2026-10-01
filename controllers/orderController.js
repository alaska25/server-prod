import Book from "../models/Book.js";
import Template from "../models/Template.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import {
  createPaypalOrder,
  capturePaypalOrder,
  getPaypalOrder,
  PaypalError,
  PAYPAL_CURRENCY,
} from "../utils/paypal.js";

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// Returns a de-duplicated array of ids, [] when omitted, or null when invalid.
const toIds = (value) => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((x) => typeof x === "string" && OBJECT_ID.test(x))
  ) {
    return null;
  }
  return [...new Set(value)];
};

const toCents = (n) => Math.round(Number(n) * 100);

// Logs the details (including PayPal's debug id) and sends a generic message.
const fail = (res, err, label, message) => {
  if (err instanceof PaypalError) {
    console.error(`${label}: PayPal error`, {
      status: err.status,
      debugId: err.debugId,
      timeout: err.timeout,
      body: err.body,
    });
  } else {
    console.error(`${label}:`, err);
  }
  return res.status(500).json({ message });
};

// Adds the purchased items to the user's library. Idempotent ($addToSet), so
// it is safe to run more than once for the same order.
const grant = (order) => {
  const add = {};
  if (order.books.length) add.library = { $each: order.books.map((b) => b.book) };
  if (order.templates.length) add.ownedTemplates = { $each: order.templates.map((t) => t.template) };
  return Object.keys(add).length ? User.findByIdAndUpdate(order.user, { $addToSet: add }) : null;
};

// POST /api/orders/paypal/create-order  { bookIds: [...], templateIds: [...] }
// Either array may be omitted/empty; at least one item across both is required.
// Prices ALWAYS come from the database, never from the client.
export const createPaypalCheckout = async (req, res) => {
  try {
    const bookIds = toIds(req.body.bookIds);
    const templateIds = toIds(req.body.templateIds);

    if (bookIds === null || templateIds === null) {
      return res.status(400).json({ message: "Invalid cart" });
    }
    if (bookIds.length === 0 && templateIds.length === 0) {
      return res.status(400).json({ message: "Your cart is empty" });
    }

    const [books, templates] = await Promise.all([
      bookIds.length
        ? Book.find({ _id: { $in: bookIds }, published: { $ne: false } })
            .select("title coverUrl price isFree")
            .lean()
        : [],
      templateIds.length
        ? Template.find({ _id: { $in: templateIds } }).select("title coverUrl price").lean()
        : [],
    ]);

    if (books.length !== bookIds.length || templates.length !== templateIds.length) {
      return res.status(400).json({ message: "One or more items are unavailable" });
    }
    // Free items are claimed through /api/books/:id/claim, not purchased.
    if (books.some((b) => b.isFree) || [...books, ...templates].some((i) => !(i.price > 0))) {
      return res.status(400).json({ message: "Free items can't be purchased" });
    }

    const alreadyOwned = await User.exists({
      _id: req.user._id,
      $or: [{ library: { $in: bookIds } }, { ownedTemplates: { $in: templateIds } }],
    });
    if (alreadyOwned) {
      return res.status(400).json({ message: "You already own one of these items" });
    }

    // Sum in cents to avoid floating point drift (0.1 + 0.2 !== 0.3).
    const totalCents = [...books, ...templates].reduce((sum, i) => sum + toCents(i.price), 0);
    const totalAmount = totalCents / 100;

    const order = await Order.create({
      user: req.user._id,
      books: books.map((b) => ({ book: b._id, title: b.title, coverUrl: b.coverUrl, price: b.price })),
      templates: templates.map((t) => ({
        template: t._id,
        title: t.title,
        coverUrl: t.coverUrl,
        price: t.price,
      })),
      totalAmount,
      currency: PAYPAL_CURRENCY,
      status: "pending",
    });

    let paypalOrderId;
    try {
      paypalOrderId = await createPaypalOrder(totalAmount, order._id.toString());
    } catch (err) {
      await Order.updateOne({ _id: order._id }, { status: "failed" });
      throw err;
    }

    await Order.updateOne({ _id: order._id }, { paypalOrderId });

    res.json({ paypalOrderId, orderId: order._id });
  } catch (err) {
    fail(res, err, "createPaypalCheckout", "Could not start checkout");
  }
};

// POST /api/orders/paypal/capture-order  { paypalOrderId }
export const capturePaypalCheckout = async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    if (typeof paypalOrderId !== "string" || !paypalOrderId) {
      return res.status(400).json({ message: "paypalOrderId is required" });
    }

    // Bound to the logged-in user: nobody can capture someone else's order.
    const order = await Order.findOne({ paypalOrderId, user: req.user._id });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Already paid: run the (idempotent) grant again, which repairs an order
    // whose first attempt crashed between marking it paid and granting access.
    if (order.status === "paid") {
      await grant(order);
      return res.json({ message: "Order already fulfilled", orderId: order._id });
    }

    let capture;
    try {
      capture = await capturePaypalOrder(paypalOrderId);
    } catch (err) {
      // The outcome may be unknown (timeout, PayPal 5xx) or the money may
      // already be captured (double click / retry). Ask PayPal what really
      // happened instead of guessing.
      const unknownOutcome =
        err instanceof PaypalError &&
        (err.timeout || err.status >= 500 || err.hasIssue("ORDER_ALREADY_CAPTURED"));
      if (!unknownOutcome) throw err;
      capture = await getPaypalOrder(paypalOrderId);
    }

    const cap = capture?.purchase_units?.[0]?.payments?.captures?.[0];

    if (capture?.status !== "COMPLETED" || cap?.status !== "COMPLETED") {
      // PENDING = payment under review; it may complete later. Don't grant yet
      // and don't mark it failed.
      if (cap?.status === "PENDING") {
        await Order.updateOne({ _id: order._id }, { status: "pending_review" });
        return res.status(202).json({ message: "Your payment is being reviewed." });
      }
      await Order.updateOne({ _id: order._id }, { status: "failed" });
      return res.status(400).json({ message: "Payment was not completed" });
    }

    // The captured amount and currency must match what the server calculated.
    if (
      toCents(cap.amount?.value) !== toCents(order.totalAmount) ||
      cap.amount?.currency_code !== PAYPAL_CURRENCY
    ) {
      console.error("Capture amount mismatch", {
        orderId: String(order._id),
        captureId: cap.id,
        expected: order.totalAmount,
        got: cap.amount,
      });
      await Order.updateOne({ _id: order._id }, { status: "needs_review", paypalCaptureId: cap.id });
      return res
        .status(500)
        .json({ message: "Payment verification failed. Please contact support." });
    }

    // Grant first (idempotent), then mark paid, so a crash in between can
    // never leave a paid order without access.
    await grant(order);
    try {
      await Order.updateOne(
        { _id: order._id, status: { $ne: "paid" } },
        { status: "paid", paypalCaptureId: cap.id, paidAt: new Date() }
      );
    } catch (err) {
      // Duplicate capture id: this capture is already recorded on an order.
      if (err?.code !== 11000) throw err;
      console.error("Duplicate paypalCaptureId", { orderId: String(order._id), captureId: cap.id });
    }

    res.json({ message: "Payment captured", orderId: order._id });
  } catch (err) {
    fail(res, err, "capturePaypalCheckout", "Could not complete payment");
  }
};

// Older orders (or deleted books) may not populate; fall back to the snapshot
// stored on the order item so the frontend always gets a title and cover.
const withSnapshot = (items, field) =>
  items.map((i) => ({ ...i, [field]: i[field] || { title: i.title, coverUrl: i.coverUrl } }));

// GET /api/orders/my
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .populate("books.book", "title coverUrl")
      .populate("templates.template", "title coverUrl")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json(
      orders.map((o) => ({
        ...o,
        books: withSnapshot(o.books || [], "book"),
        templates: withSnapshot(o.templates || [], "template"),
      }))
    );
  } catch (err) {
    fail(res, err, "getMyOrders", "Server error");
  }
};

// GET /api/orders (admin)?page=&limit=  - still returns an array.
export const getAllOrders = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const orders = await Order.find({})
      .populate("user", "name email")
      .populate("books.book", "title")
      .populate("templates.template", "title")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json(
      orders.map((o) => ({
        ...o,
        books: withSnapshot(o.books || [], "book"),
        templates: withSnapshot(o.templates || [], "template"),
      }))
    );
  } catch (err) {
    fail(res, err, "getAllOrders", "Server error");
  }
};