import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../utils/s3.js";
import sendEmail from "../utils/sendEmail.js";

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// How long a reset link stays valid after being requested.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Verifies a Turnstile token server-side. Returns true only if Cloudflare
// confirms the token is valid, unused, and was issued for this site.
const verifyCaptcha = async (token, remoteIp) => {
  if (!token) return false;

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
    const email = req.body.email?.trim().toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    const captchaOk = await verifyCaptcha(captchaToken, req.ip);
    if (!captchaOk) {
      return res.status(400).json({ message: "Captcha verification failed. Please try again." });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }

    const user = await User.create({ name, email, password });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      photoUrl: user.photoUrl,
      token: generateToken(user._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const loginUser = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const { password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Rejected here, before a token is ever issued, so a deactivated user
    // gets a clear message right at login instead of a token that then
    // fails on their first API call.
    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated." });
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      photoUrl: user.photoUrl,
      token: generateToken(user._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/google
// Body: { credential } — the ID token string from Google Identity Services
// on the frontend (google.accounts.id credential response).
//
// Verifies the token directly with Google (so a forged/expired token is
// rejected before we ever trust the email in it), then finds a matching
// user by googleId first, then by email (to link an existing
// password-based account the first time they use Google), or creates a
// brand-new account if neither exists. Returns the same shape as
// loginUser/registerUser so the frontend can treat it identically.
export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
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

    if (!payload?.email) {
      return res.status(401).json({ message: "Could not verify Google account." });
    }

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ googleId: payload.sub });

    if (!user) {
      // No account linked to this Google ID yet — check if an existing
      // password-based account shares the email, and link it rather than
      // creating a duplicate. Google verifies email ownership for us, so
      // this is safe to do without an extra confirmation step.
      user = await User.findOne({ email });
      if (user) {
        user.googleId = payload.sub;
        await user.save();
      } else {
        user = await User.create({
          name: payload.name || email.split("@")[0],
          email,
          googleId: payload.sub,
          photoUrl: payload.picture,
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated." });
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      photoUrl: user.photoUrl,
      token: generateToken(user._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/forgot-password
// Always responds with the same generic message whether or not the email
// belongs to an account — this prevents the endpoint being used to check
// which emails are registered.
export const forgotPassword = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const genericResponse = {
      message: "If an account exists for this email, we've sent a link to reset your password.",
    };

    const user = await User.findOne({ email });
    if (!user) {
      return res.json(genericResponse);
    }

    // Only the hash is stored; the raw token goes out in the email only,
    // the same reasoning as never storing a plaintext password.
    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.resetPasswordExpires = Date.now() + RESET_TOKEN_TTL_MS;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your Adyoolau password",
        html: `
          <p>Hi ${user.name},</p>
          <p>Click the link below to set a new password. This link expires in 1 hour.</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      });
    } catch (emailErr) {
      // Roll back the token rather than leaving a valid, unusable reset
      // request sitting on the account if the email genuinely failed to send.
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save({ validateBeforeSave: false });
      console.error("forgotPassword email error:", emailErr.message);
      return res.status(500).json({ message: "Could not send reset email." });
    }

    res.json(genericResponse);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/reset-password
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select("+resetPasswordToken +resetPasswordExpires");

    if (!user) {
      return res.status(400).json({ message: "This reset link is invalid or has expired." });
    }

    user.password = password; // re-hashed by the pre-save hook
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: "Password has been reset." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getProfile = async (req, res) => {
  res.json(req.user);
};

export const getMyLibrary = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("library");
    res.json(user.library);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/photo (protected) - expects multipart/form-data with a
// single 'photo' field. Replaces the caller's own profile photo. Used from
// the admin dashboard so admins can upload a professional headshot.
export const uploadUserPhoto = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const photoFile = req.files?.photo?.[0];
    if (!photoFile) {
      return res.status(400).json({ message: "A photo is required" });
    }
    if (!["image/png", "image/jpeg"].includes(photoFile.mimetype)) {
      return res.status(400).json({ message: "Photo must be a PNG or JPEG image" });
    }

    // Best-effort cleanup of the previous photo, if any, before saving the new one.
    if (user.photoKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: user.photoKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old photo):", s3Err.message);
      }
    }

    user.photoKey = photoFile.key;
    user.photoUrl = photoFile.location || publicUrl(photoFile.key);
    await user.save();

    res.json({ photoUrl: user.photoUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};