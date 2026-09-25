import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select("-password");
      if (!req.user) {
        return res.status(401).json({ message: "User no longer exists" });
      }
      // Blocks a deactivated user even if their token is still valid, so
      // deactivating someone takes effect immediately, not just on their
      // next login.
      if (!req.user.isActive) {
        return res.status(403).json({ message: "This account has been deactivated." });
      }
      return next();
    } catch (err) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  return res.status(401).json({ message: "Not authorized, no token" });
};

// Admin-gated routes: a superadmin can do everything an admin can, so both
// roles pass here.
export const admin = (req, res, next) => {
  if (req.user && (req.user.role === "admin" || req.user.role === "superadmin")) {
    return next();
  }
  return res.status(403).json({ message: "Admin access required" });
};

// Superadmin-only routes, e.g. promoting/demoting other admins. Regular
// admins are blocked here even though they pass `admin` above.
export const superAdmin = (req, res, next) => {
  if (req.user && req.user.role === "superadmin") {
    return next();
  }
  return res.status(403).json({ message: "Superadmin access required" });
};