import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../utils/s3.js";
import sendEmail from "../utils/sendEmail.js";

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    // Consider a shorter lifetime (e.g. "1d") if your frontend can handle
    // re-login; passwordChangedAt already revokes tokens after a reset.
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// Base URL for links in emails. CLIENT_URL may list several origins
// (comma separated); APP_URL, if set, wins.
const appUrl = () =>
  (process.env.APP_URL || process.env.CLIENT_URL.split(",")[0]).trim().replace(/\/$/, "");

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // bcrypt ignores anything longer

// How long a reset link stays valid, and the minimum gap between reset emails
// for the same account (stops inbox flooding).
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const authResponse = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  photoUrl: user.photoUrl,
  token: generateToken(user._id),
});

const serverError = (res, err, label) => {
  console.error(`${label}:`, err);
  return res.status(500).json({ message: "Server error" });
};

const cleanEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const removeFromS3 = async (key) => {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  } catch (s3Err) {
    console.warn("S3 cleanup warning:", s3Err.message);
  }
};

// Verifies a Turnstile token server-side. Returns true only if Cloudflare
// confirms the token is valid, unused, and was issued for this site.
const verifyCaptcha = async (token, remoteIp) => {
  if (!token || typeof token !== "string") return false;

  try {
    const params = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
    });
    if (remoteIp) params.append("remoteip", remoteIp);

    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(5000), // don't let a slow Cloudflare hang signups
    });
    const data = await verifyRes.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verification error:", err.message);
    return false;
  }
};

export const registerUser = async (req, res) => {
  try {
    const { name, password, captchaToken } = req.body;
    // The schema lowercases email on save, but that setter does NOT apply
    // to query filters — normalize here so the findOne below actually
    // catches existing accounts regardless of casing.
    const email = cleanEmail(req.body.email);

    if (typeof name !== "string" || !name.trim() || !email || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return res
        .status(400)
        .json({ message: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters` });
    }

    const captchaOk = await verifyCaptcha(captchaToken, req.ip);
    if (!captchaOk) {
      return res.status(400).json({ message: "Captcha verification failed. Please try again." });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }

    const user = await User.create({ name: name.trim(), email, password });
    res.status(201).json(authResponse(user));
  } catch (err) {
    // Two signups racing for the same email: the unique index catches it.
    if (err?.code === 11000) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }
    if (err?.name === "ValidationError") {
      return res.status(400).json({ message: Object.values(err.errors).map((e) => e.message).join(", ") });
    }
    serverError(res, err, "registerUser");
  }
};

export const loginUser = async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const { password } = req.body;

    if (!email || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email });

    // matchPassword returns false for Google-only accounts (no password hash).
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Rejected here, before a token is ever issued.
    if (user.isActive === false) {
      return res.status(403).json({ message: "This account has been deactivated." });
    }

    res.json(authResponse(user));
  } catch (err) {
    serverError(res, err, "loginUser");
  }
};

// POST /api/auth/google
// Body: { credential } — the ID token string from Google Identity Services.
//
// Verifies the token directly with Google, requires Google to report the
// email as verified, then finds the user by googleId, then by email (linking
// an existing password-based account), or creates a new account.
export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;
    if (typeof credential !== "string" || !credential) {
      return res.status(400).json({ message: "Missing Google credential" });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      console.error("Google token verification error:", verifyErr.message);
      return res.status(401).json({ message: "Could not verify Google account." });
    }

    // Google must vouch that this email really belongs to the person.
    if (!payload?.email || payload.email_verified !== true) {
      return res.status(401).json({ message: "Could not verify Google account." });
    }

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ googleId: payload.sub });

    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        if (user.googleId && user.googleId !== payload.sub) {
          return res.status(401).json({ message: "Could not verify Google account." });
        }
        user.googleId = payload.sub;
        if (!user.emailVerified) {
          // This account may have been registered with a password by someone
          // who never proved they own the email. Google just proved the real
          // owner is here, so remove any existing password and invalidate old
          // sessions. The owner can set a new password via "Forgot password".
          if (user.password) {
            user.password = undefined;
            user.passwordChangedAt = new Date();
          }
          user.emailVerified = true;
        }
        await user.save();
      } else {
        user = await User.create({
          name: payload.name || email.split("@")[0],
          email,
          googleId: payload.sub,
          photoUrl: payload.picture,
          emailVerified: true,
        });
      }
    } else if (!user.emailVerified) {
      user.emailVerified = true;
      await user.save();
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: "This account has been deactivated." });
    }

    res.json(authResponse(user));
  } catch (err) {
    serverError(res, err, "googleAuth");
  }
};

// POST /api/auth/forgot-password
// ALWAYS answers with the same generic message (even if sending the email
// fails), so the endpoint can't be used to check which emails are registered.
export const forgotPassword = async (req, res) => {
  const genericResponse = {
    message: "If an account exists for this email, we've sent a link to reset your password.",
  };

  try {
    const email = cleanEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email }).select("+resetPasswordExpires");
    if (!user || user.isActive === false) {
      return res.json(genericResponse);
    }

    // Per-account cooldown: if a link was issued moments ago, don't send another.
    if (user.resetPasswordExpires) {
      const issuedAt = user.resetPasswordExpires.getTime() - RESET_TOKEN_TTL_MS;
      if (Date.now() - issuedAt < RESET_COOLDOWN_MS) {
        return res.json(genericResponse);
      }
    }

    // Only the hash is stored; the raw token goes out in the email only.
    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${appUrl()}/reset-password?token=${rawToken}`;

    // NOT awaited on purpose: waiting for the mail server would make this request
    // slower for real accounts than for unknown emails, which would reveal which
    // emails are registered. If sending fails, the token is rolled back in the
    // background (so no valid-but-undelivered reset is left on the account).
    sendEmail({
      to: user.email,
      subject: "Reset your Adyoolau password",
      html: `
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>Click the link below to set a new password. This link expires in 1 hour.</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
    }).catch(async (emailErr) => {
      console.error("forgotPassword email error:", emailErr.message);
      try {
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save({ validateBeforeSave: false });
      } catch (rollbackErr) {
        console.error("forgotPassword rollback error:", rollbackErr.message);
      }
    });

    res.json(genericResponse);
  } catch (err) {
    console.error("forgotPassword:", err);
    // Same generic answer, so failures don't reveal whether the email exists.
    res.json(genericResponse);
  }
};

// POST /api/auth/reset-password
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (typeof token !== "string" || !token || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return res
        .status(400)
        .json({ message: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters` });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    }).select("+resetPasswordToken +resetPasswordExpires");

    if (!user) {
      return res.status(400).json({ message: "This reset link is invalid or has expired." });
    }

    user.password = password; // re-hashed by the pre-save hook, which also sets passwordChangedAt
    user.emailVerified = true; // the emailed link proves ownership of the address
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: "Password has been reset." });
  } catch (err) {
    if (err?.name === "ValidationError") {
      return res.status(400).json({ message: Object.values(err.errors).map((e) => e.message).join(", ") });
    }
    serverError(res, err, "resetPassword");
  }
};

// GET /api/auth/profile — explicit fields only (no googleId, photoKey, hashes).
export const getProfile = async (req, res) => {
  const u = req.user;
  res.json({
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    photoUrl: u.photoUrl,
    isActive: u.isActive,
    emailVerified: u.emailVerified,
    library: u.library,
    ownedTemplates: u.ownedTemplates,
    createdAt: u.createdAt,
  });
};

// GET /api/auth/library — owned books, WITHOUT the private file location.
export const getMyLibrary = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("library")
      .populate({
        path: "library",
        select:
          "title subtitle author category price isFree featured fileType coverUrl pageCount avgRating reviewCount createdAt",
      })
      .lean();
    res.json(user?.library ?? []);
  } catch (err) {
    serverError(res, err, "getMyLibrary");
  }
};

// POST /api/auth/photo (protected) - expects multipart/form-data with a
// single 'photo' field. The upload middleware already validated the type and
// converted the image to WebP.
export const uploadUserPhoto = async (req, res) => {
  const photoFile = req.files?.photo?.[0];
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      await removeFromS3(photoFile?.key);
      return res.status(404).json({ message: "User not found" });
    }
    if (!photoFile) {
      return res.status(400).json({ message: "A photo is required" });
    }

    const oldKey = user.photoKey;

    user.photoKey = photoFile.key;
    user.photoUrl = photoFile.location || publicUrl(photoFile.key);
    await user.save();

    // Delete the old photo only after the new one is safely saved.
    await removeFromS3(oldKey);

    res.json({ photoUrl: user.photoUrl });
  } catch (err) {
    await removeFromS3(photoFile?.key);
    serverError(res, err, "uploadUserPhoto");
  }
};