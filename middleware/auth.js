import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const protect = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer")) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  const token = req.headers.authorization.split(" ")[1];

  // 1) Token problems -> 401
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Not authorized, invalid token" });
  }

  // 2) Database problems -> 500 (so the frontend doesn't mistake a database
  // hiccup for an expired session and log the user out).
  try {
    // Kept as a full mongoose document (no .lean() / no field exclusions
    // beyond password) so other controllers that use req.user.library or
    // req.user.save() keep working. If you confirm nothing does, you can
    // switch to: .select("-password -library").lean()
    req.user = await User.findById(decoded.id).select("-password");
  } catch (err) {
    console.error("Auth lookup failed:", err.message);
    return res.status(500).json({ message: "Server error" });
  }

  if (!req.user) {
    return res.status(401).json({ message: "User no longer exists" });
  }

  // Blocks a deactivated user even if their token is still valid, so
  // deactivating someone takes effect immediately.
  if (!req.user.isActive) {
    return res.status(403).json({ message: "This account has been deactivated." });
  }

  return next();
};

// Admin-gated routes: a superadmin can do everything an admin can, so both
// roles pass here.
export const admin = (req, res, next) => {
  if (req.user && (req.user.role === "admin" || req.user.role === "superadmin")) {
    return next();
  }
  return res.status(403).json({ message: "Admin access required" });
};

// Superadmin-only routes, e.g. promoting/demoting other admins.
export const superAdmin = (req, res, next) => {
  if (req.user && req.user.role === "superadmin") {
    return next();
  }
  return res.status(403).json({ message: "Superadmin access required" });
};