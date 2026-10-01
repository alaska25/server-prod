import User from "../models/User.js";

const ROLES = ["user", "admin", "superadmin"];
const RANK = { user: 0, admin: 1, superadmin: 2 };

// Promoting someone to admin/superadmin requires that they have proven they own
// their email address (Google sign-in, or a completed password-reset link).
// Otherwise someone could pre-register a staff member's address with their own
// password and later be promoted by mistake. Set to false to disable.
const REQUIRE_VERIFIED_EMAIL_FOR_PROMOTION = true;

const serverError = (res, err, label) => {
  console.error(`${label}:`, err);
  return res.status(500).json({ message: "Server error" });
};

// One line of JSON per privilege change (IDs only, no personal data), so you
// can see who changed what.
const audit = (req, action, targetId, details) =>
  console.info(
    JSON.stringify({
      audit: action,
      at: new Date().toISOString(),
      actor: String(req.user._id),
      target: String(targetId),
      ...details,
    })
  );

// Accounts created before the `isActive` field existed have no value, and
// count as active.
const countActiveSuperadmins = () =>
  User.countDocuments({ role: "superadmin", isActive: { $ne: false } });

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Shared by the two list endpoints. Still returns a plain array.
//   ?page=1&limit=500 (max 1000)&search=text (matches name or email)
const listUsers = async (req, res, roleFilter, label) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const query = { role: roleFilter };
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: rx }, { email: rx }];
    }

    const users = await User.find(query)
      .select("-password -googleId -photoKey")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json(users);
  } catch (err) {
    serverError(res, err, label);
  }
};

// GET /users/admins — admin management list: admins + superadmins only.
export const getAdmins = (req, res) =>
  listUsers(req, res, { $in: ["admin", "superadmin"] }, "getAdmins");

// GET /users/customers — regular customers only.
export const getCustomers = (req, res) => listUsers(req, res, "user", "getCustomers");

// PUT /users/:id/role — change a user's role. Superadmin-only.
export const updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;

    if (typeof role !== "string" || !ROLES.includes(role)) {
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

    // A deactivated account shouldn't have its role changed while locked out:
    // reactivate it first. Enforced here, not just hidden in the UI.
    if (user.isActive === false) {
      return res.status(400).json({ message: "Reactivate this account before changing its role" });
    }

    const previousRole = user.role;
    if (previousRole === role) return res.json(user); // nothing to change

    if (
      REQUIRE_VERIFIED_EMAIL_FOR_PROMOTION &&
      RANK[role] > RANK[previousRole] &&
      user.emailVerified !== true
    ) {
      return res.status(400).json({
        message:
          "This account's email isn't verified yet. Ask them to sign in with Google or use 'Forgot password' once, then promote them.",
      });
    }

    // Friendly early check for the last superadmin...
    const demotingSuperadmin = previousRole === "superadmin" && role !== "superadmin";
    if (demotingSuperadmin && (await countActiveSuperadmins()) <= 1) {
      return res.status(400).json({ message: "Cannot demote the last active superadmin" });
    }

    // ...then a conditional update (only applies if the role is still what we
    // read), so two people changing the same user can't overwrite each other.
    const updated = await User.findOneAndUpdate(
      { _id: user._id, role: previousRole },
      { role },
      { new: true }
    );
    if (!updated) {
      return res
        .status(409)
        .json({ message: "This user was changed by someone else. Refresh and try again." });
    }

    // The early check isn't atomic: two superadmins demoting each other at the
    // same moment could both pass it. Re-check after the change and undo it if
    // it would leave no active superadmin. (Worst case both are undone: safe.)
    if (demotingSuperadmin && (await countActiveSuperadmins()) < 1) {
      await User.updateOne({ _id: user._id, role }, { role: previousRole });
      return res.status(409).json({ message: "Cannot demote the last active superadmin" });
    }

    audit(req, "role_change", user._id, { from: previousRole, to: role });
    res.json(updated);
  } catch (err) {
    serverError(res, err, "updateUserRole");
  }
};

// PUT /users/:id/status — activate/deactivate a user. Superadmin-only.
export const updateUserStatus = async (req, res) => {
  try {
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

    const wasActive = user.isActive !== false;
    if (wasActive === isActive) return res.json(user); // nothing to change

    const deactivatingSuperadmin = user.role === "superadmin" && !isActive;
    if (deactivatingSuperadmin && (await countActiveSuperadmins()) <= 1) {
      return res.status(400).json({ message: "Cannot deactivate the last active superadmin" });
    }

    // Only applies if the role is unchanged since we read it (e.g. nobody
    // promoted or demoted this user in the meantime).
    const updated = await User.findOneAndUpdate(
      { _id: user._id, role: user.role },
      { isActive },
      { new: true }
    );
    if (!updated) {
      return res
        .status(409)
        .json({ message: "This user was changed by someone else. Refresh and try again." });
    }

    if (deactivatingSuperadmin && (await countActiveSuperadmins()) < 1) {
      await User.updateOne({ _id: user._id }, { isActive: true });
      return res.status(409).json({ message: "Cannot deactivate the last active superadmin" });
    }

    audit(req, "status_change", user._id, { isActive });
    res.json(updated);
  } catch (err) {
    serverError(res, err, "updateUserStatus");
  }
};