import Stripe from "stripe";
import Book from "../models/Book.js";
import Order from "../models/Order.js";
import User from "../models/User.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /api/orders/checkout  { bookIds: [...] }
export const createCheckoutSession = async (req, res) => {
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: books.map((b) => ({
        price_data: {
          currency: "usd",
          product_data: { name: b.title },
          unit_amount: Math.round(b.price * 100),
        },
        quantity: 1,
      })),
      success_url: `${process.env.CLIENT_URL}/checkout/success?order=${order._id}`,
      cancel_url: `${process.env.CLIENT_URL}/cart`,
      metadata: { orderId: order._id.toString(), userId: req.user._id.toString() },
    });

    order.stripeSessionId = session.id;
    await order.save();

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/orders/webhook  (Stripe webhook - raw body required, see routes)
export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    const userId = session.metadata?.userId;

    try {
      const order = await Order.findById(orderId);
      if (order && order.status !== "paid") {
        order.status = "paid";
        order.stripePaymentIntentId = session.payment_intent;
        await order.save();

        const bookIds = order.books.map((b) => b.book);
        await User.findByIdAndUpdate(userId, { $addToSet: { library: { $each: bookIds } } });
      }
    } catch (err) {
      console.error("Error fulfilling order:", err.message);
    }
  }

  res.json({ received: true });
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
