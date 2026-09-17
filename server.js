import "./config/env.js"; // must be first: loads .env before any other import runs
import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import authRoutes from "./routes/authRoutes.js";
import bookRoutes from "./routes/bookRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import { stripeWebhook } from "./controllers/orderController.js";

connectDB();

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

// Stripe webhook needs the raw body, so it's mounted BEFORE express.json()
app.post("/api/orders/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/books", bookRoutes);
app.use("/api/orders", orderRoutes);

// Central error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Adyoolau API running on port ${PORT}`));