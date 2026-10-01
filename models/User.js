import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Not required when the account was created via Google sign-in — those
    // users never set a password and authenticate through Google instead.
    // maxlength 72: bcrypt ignores everything past 72 bytes.
    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: 8,
      maxlength: 72,
    },
    // Set only for accounts created or linked via "Continue with Google".
    // sparse + unique so multiple normal accounts (with no googleId at all)
    // don't collide on the missing value. Never set this to null.
    googleId: { type: String, unique: true, sparse: true },
    role: { type: String, enum: ["user", "admin", "superadmin"], default: "user" },
    isActive: { type: Boolean, default: true },
    // True once the person has proven they own the email (Google sign-in with a
    // verified email, or a completed password-reset link).
    emailVerified: { type: Boolean, default: false },
    // Tokens issued before this moment are rejected by the `protect` middleware.
    passwordChangedAt: { type: Date },
    library: [{ type: mongoose.Schema.Types.ObjectId, ref: "Book" }],
    ownedTemplates: [{ type: mongoose.Schema.Types.ObjectId, ref: "Template" }],
    // Optional profile photo.
    photoUrl: { type: String },
    photoKey: { type: String },
    // Forgot-password flow. Only a SHA-256 hash of the reset token is stored.
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

// Admin lists (role filter, newest first).
userSchema.index({ role: 1, createdAt: -1 });

// Reset links are looked up by token hash.
userSchema.index({ resetPasswordToken: 1 }, { sparse: true });

// Never serialize secrets, even if a controller returns a whole user document.
// (Does not apply to .lean() results, so keep explicit .select()s there.)
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.googleId;
    delete ret.photoKey;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    delete ret.__v;
    return ret;
  },
});

// NOTE: this hook only runs for save()/create(). Never set a password with
// findByIdAndUpdate/updateOne — it would be stored in plaintext.
// (No `next` callback: that style was removed in Mongoose 9, and async hooks
// without it also work on older versions.)
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  // 1s slack so a token issued right after the change is still accepted.
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
});

userSchema.methods.matchPassword = function (enteredPassword) {
  // A Google-only account has no password hash to compare against, and
  // bcrypt.compare throws on non-string input.
  if (!this.password || typeof enteredPassword !== "string") return Promise.resolve(false);
  return bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model("User", userSchema);