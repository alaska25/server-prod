import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Not required when the account was created via Google sign-in — those
    // users never set a password and authenticate through Google instead.
    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: 6,
    },
    // Set only for accounts created or linked via "Continue with Google".
    // sparse + unique so multiple normal accounts (with no googleId at all)
    // don't collide on the null value.
    googleId: { type: String, unique: true, sparse: true },
    role: { type: String, enum: ["user", "admin", "superadmin"], default: "user" },
    isActive: { type: Boolean, default: true },
    library: [{ type: mongoose.Schema.Types.ObjectId, ref: "Book" }],
    ownedTemplates: [{ type: mongoose.Schema.Types.ObjectId, ref: "Template" }],
    // Optional profile photo, uploaded from the admin dashboard. Not
    // required, so existing users without one keep working fine.
    photoUrl: { type: String },
    photoKey: { type: String },
    // Forgot-password flow. We only ever store a SHA-256 hash of the reset
    // token (see authController.forgotPassword) — the raw token only ever
    // exists in the emailed link, never in the database, the same reasoning
    // as hashing the password itself.
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = function (enteredPassword) {
  // A Google-only account has no password hash to compare against.
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model("User", userSchema);