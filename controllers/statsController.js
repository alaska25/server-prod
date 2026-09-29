import Order from "../models/Order.js";
import User from "../models/User.js";
import Book from "../models/Book.js";
import Template from "../models/Template.js";

const DAYS_BACK = 30;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Dashboard numbers don't need to be accurate to the second, so cache the
// full response briefly. Turns repeated visits/refreshes within the same
// minute into an instant response instead of re-running the aggregations
// every time.
let statsCache = { data: null, at: 0 };

// Call this after an order is marked paid (e.g. at the end of capture-order)
// so the admin dashboard shows the new sale immediately instead of after
// the cache expires.
export const clearStatsCache = () => {
  statsCache = { data: null, at: 0 };
};

const dayKey = (date) => date.toISOString().slice(0, 10); // "YYYY-MM-DD"

// Builds an array of the last `days` day-keys (oldest first), so charts get
// a continuous line even on days with zero orders/signups instead of gaps.
const lastNDayKeys = (days) => {
  const keys = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
};

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// GET /stats/dashboard — superadmin-only, see statsRoutes.js.
export const getDashboardStats = async (req, res) => {
  try {
    if (statsCache.data && Date.now() - statsCache.at < CACHE_TTL_MS) {
      return res.json(statsCache.data);
    }

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (DAYS_BACK - 1));
    since.setUTCHours(0, 0, 0, 0);

    const [
      revenueAgg,
      totalOrders,
      paidOrders,
      activeUsers,
      totalBooks,
      totalTemplates,
      revenueByDayRaw,
      userGrowthRaw,
      topBooksRaw,
      topTemplatesRaw,
      orderStatusRaw,
      revenueSplitRaw,
    ] = await Promise.all([
      Order.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Order.countDocuments(),
      Order.countDocuments({ status: "paid" }),
      User.countDocuments({ isActive: { $ne: false } }),
      Book.countDocuments(),
      Template.countDocuments(),
      Order.aggregate([
        { $match: { status: "paid", createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$totalAmount" },
          },
        },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: { status: "paid" } },
        { $unwind: "$books" },
        {
          $group: {
            _id: "$books.book",
            unitsSold: { $sum: 1 },
            revenue: { $sum: "$books.price" },
          },
        },
        { $sort: { unitsSold: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: "books",
            localField: "_id",
            foreignField: "_id",
            as: "book",
          },
        },
        { $unwind: "$book" },
        {
          $project: {
            _id: 0,
            bookId: "$_id",
            title: "$book.title",
            unitsSold: 1,
            revenue: 1,
          },
        },
      ]),
      Order.aggregate([
        { $match: { status: "paid" } },
        { $unwind: "$templates" },
        {
          $group: {
            _id: "$templates.template",
            unitsSold: { $sum: 1 },
            revenue: { $sum: "$templates.price" },
          },
        },
        { $sort: { unitsSold: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: "templates",
            localField: "_id",
            foreignField: "_id",
            as: "template",
          },
        },
        { $unwind: "$template" },
        {
          $project: {
            _id: 0,
            templateId: "$_id",
            title: "$template.title",
            unitsSold: 1,
            revenue: 1,
          },
        },
      ]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { status: "paid" } },
        {
          $facet: {
            books: [
              { $unwind: "$books" },
              { $group: { _id: null, revenue: { $sum: "$books.price" } } },
            ],
            templates: [
              { $unwind: "$templates" },
              { $group: { _id: null, revenue: { $sum: "$templates.price" } } },
            ],
          },
        },
      ]),
    ]);

    // Fill every day in the window, defaulting to 0 where there's no data.
    const dayKeys = lastNDayKeys(DAYS_BACK);
    const revenueByDate = Object.fromEntries(revenueByDayRaw.map((r) => [r._id, r.revenue]));
    const revenueByDay = dayKeys.map((date) => ({
      date,
      revenue: round2(revenueByDate[date]),
    }));

    const signupsByDate = Object.fromEntries(userGrowthRaw.map((r) => [r._id, r.count]));
    const userGrowthByDay = dayKeys.map((date) => ({
      date,
      count: signupsByDate[date] || 0,
    }));

    const orderStatus = orderStatusRaw.map((r) => ({ status: r._id, count: r.count }));

    const revenueSplit = [
      { source: "books", revenue: round2(revenueSplitRaw[0]?.books[0]?.revenue) },
      { source: "templates", revenue: round2(revenueSplitRaw[0]?.templates[0]?.revenue) },
    ];

    const payload = {
      totals: {
        totalRevenue: round2(revenueAgg[0]?.total),
        totalOrders, // every order, including pending and failed
        paidOrders, // only orders that count toward revenue
        activeUsers,
        totalBooks,
        totalTemplates,
      },
      revenueByDay,
      userGrowthByDay,
      topBooks: topBooksRaw,
      topTemplates: topTemplatesRaw,
      orderStatus,
      revenueSplit,
    };

    statsCache = { data: payload, at: Date.now() };
    res.json(payload);
  } catch (err) {
    console.error("Dashboard stats failed:", err);
    res.status(500).json({ message: "Could not load dashboard stats." });
  }
};