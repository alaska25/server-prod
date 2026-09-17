// Usage: node scripts/createAdmin.js admin@example.com "Admin Name" "StrongPassword123"
// Creates the user if it doesn't exist, or promotes an existing user to admin.
import dotenv from "dotenv";
import connectDB from "../config/db.js";
import User from "../models/User.js";

dotenv.config();

const [, , email, name, password] = process.argv;

if (!email) {
  console.error("Usage: node scripts/createAdmin.js <email> [name] [password]");
  process.exit(1);
}

const run = async () => {
  await connectDB();

  let user = await User.findOne({ email });
  if (user) {
    user.role = "admin";
    await user.save();
    console.log(`Existing user ${email} promoted to admin.`);
  } else {
    if (!name || !password) {
      console.error("Creating a new admin requires name and password too.");
      process.exit(1);
    }
    user = await User.create({ name, email, password, role: "admin" });
    console.log(`Admin user ${email} created.`);
  }

  process.exit(0);
};

run();
