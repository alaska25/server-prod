import mongoose from "mongoose";

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MongoDB connection error: MONGO_URI is not set");
    process.exit(1);
  }

  // Runtime problems after the first successful connection (network drop,
  // failover) only show up as events, so log them.
  mongoose.connection.on("error", (err) => console.error("MongoDB error:", err.message));
  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Fail after 10s instead of the driver's default 30s.
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS) || 10_000,
      // Connections per server instance. The driver default (100) can exhaust
      // small database tiers when more than one instance runs.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL) || 20,
      // Set MONGO_AUTO_INDEX=false to stop building indexes on every start
      // (then run scripts/createIndexes.js when the schema changes).
      autoIndex: process.env.MONGO_AUTO_INDEX !== "false",
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

export default connectDB;