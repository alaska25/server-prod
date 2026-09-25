import User from "../models/User.js";

// GET /users/admins — admin management list: admins + superadmins only.
export const getAdmins = async (req, res) => {
  const admins = await User.find({ role: { $in: ["admin", "superadmin"] } })
    .select("-password")
    .sort({ createdAt: -1 });
  res.json(admins);
};

// GET /users/customers — regular customers only.
export const getCustomers = async (req, res) => {
  const customers = await User.find({ role: "user" })
    .select("-password")
    .sort({ createdAt: -1 });
  res.json(customers);
};

// PUT /users/:id/role — change a user's role. Superadmin-only.
export const updateUserRole = async (req, res) => {
  const { role } = req.body;
  const allowedRoles = ["user", "admin", "superadmin"];

  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  // Stop a superadmin from demoting themselves and locking everyone out.
  if (req.params.id === String(req.user._id) && role !== "superadmin") {
    return res.status(400).json({ message: "You can't change your own role" });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  // Stop demoting the last remaining superadmin.
  if (user.role === "superadmin" && role !== "superadmin") {
    const superadminCount = await User.countDocuments({ role: "superadmin", isActive: true });
    if (superadminCount <= 1) {
      return res.status(400).json({ message: "Cannot demote the last active superadmin" });
    }
  }

  user.role = role;
  await user.save();

  const { password, ...safeUser } = user.toObject();
  res.json(safeUser);
};

// PUT /users/:id/status — activate/deactivate a user. Superadmin-only.
export const updateUserStatus = async (req, res) => {
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    return res.status(400).json({ message: "isActive must be true or false" });
  }

  // Stop a superadmin from locking themselves out.
  if (req.params.id === String(req.user._id) && !isActive) {
    return res.status(400).json({ message: "You can't deactivate your own account" });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  // Stop deactivating the last remaining active superadmin.
  if (user.role === "superadmin" && !isActive) {
    const superadminCount = await User.countDocuments({ role: "superadmin", isActive: true });
    if (superadminCount <= 1) {
      return res.status(400).json({ message: "Cannot deactivate the last active superadmin" });
    }
  }

  user.isActive = isActive;
  await user.save();

  const { password, ...safeUser } = user.toObject();
  res.json(safeUser);
};