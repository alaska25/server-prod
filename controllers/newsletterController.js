import Subscriber from "../models/Subscriber.js";

// POST /api/newsletter/subscribe  { email }
export const subscribe = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ message: "A valid email address is required" });
    }

    const existing = await Subscriber.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.json({ message: "You're already subscribed!" });
    }

    await Subscriber.create({ email: email.toLowerCase() });
    res.status(201).json({ message: "Subscribed! Thanks for joining." });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ message: "You're already subscribed!" });
    }
    res.status(500).json({ message: err.message });
  }
};