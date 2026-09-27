import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3 from "../utils/s3.js";

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

export const registerUser = async (req, res) => {
  try {
    const { name, password } = req.body;
    // The schema lowercases email on save, but that setter does NOT apply
    // to query filters — normalize here so the findOne below actually
    // catches existing accounts regardless of casing.
    const email = req.body.email?.trim().toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
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