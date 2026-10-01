// Creates every index defined in the Mongoose models, one model at a time, and
// reports failures clearly. Safe to run repeatedly: it only creates what is
// missing and never drops anything.
//
// Run from the backend folder:   node scripts/createIndexes.js
//
// Most useful the first time after deploying the new code: the unique indexes on
// orders (paypalOrderId, paypalCaptureId) and users (email, googleId) FAIL to
// build if duplicate values already exist, and this shows exactly which model
// and why.
import "../config/env.js"; // must be first: loads .env
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Book from "../models/Book.js";
import Template from "../models/Template.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import Review from "../models/Review.js";
// Add any other models here (newsletter subscribers, support messages, ...).

const models = [Book, Template, User, Order, Review];

await connectDB();

let failed = 0;
for (const Model of models) {
  try {
    await Model.createIndexes();
    const indexes = await Model.collection.indexes();
    console.log(`OK    ${Model.modelName}: ${indexes.length} indexes (${indexes.map((i) => i.name).join(", ")})`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${Model.modelName}: ${err.message}`);
  }
}

await mongoose.connection.close();
console.log(failed ? `\n${failed} model(s) failed. Fix the data/conflict above and run again.` : "\nAll indexes are in place.");
process.exit(failed ? 1 : 0);