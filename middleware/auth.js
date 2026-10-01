import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  const token = header.slice(7).trim();

  // 1) Token problems -> 401
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ message: "Not authorized, invalid token" });
  }
  if (typeof decoded?.id !== "string" || !/^[0-9a-fA-F]{24}$/.test(decoded.id)) {
    return res.status(401).json({ message: "Not authorized, invalid token" });
  }

  // 2) Database problems -> 500 (so the frontend doesn't mistake a database
  // hiccup for an expired session and log the user out).
  try {
    // Kept as a full mongoose document (only the password is excluded) so any
    // controller that uses req.user.library or req.user.save() keeps working.
    // If you confirm nothing does, switch to:
    //   .select("_id name email role isActive passwordChangedAt").lean()
    // and use `=== false` for the isActive check (lean skips schema defaults).
    req.user = await User.findById(decoded.id).select("-password");
  } catch (err) {
    console.error("Auth lookup failed:", err.message);
    return res.status(500).json({ message: "Server error" });
  }

  if (!req.user) {
    return res.status(401).json({ message: "User no longer exists" });
  }

  // Blocks a deactivated user even if their token is still valid.
  // `=== false` so accounts without the field are not locked out.
  if (req.user.isActive === false) {
    return res.status(403).json({ message: "This account has been deactivated." });
  }

  // Tokens issued before the last password change/reset are no longer valid.
  if (
    req.user.passwordChangedAt &&
    typeof decoded.iat === "number" &&
    decoded.iat * 1000 < req.user.passwordChangedAt.getTime()
  ) {
    return res.status(401).json({ message: "Session expired, please log in again" });
  }

  return next();
};

// Admin-gated routes: a superadmin can do everything an admin can.
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