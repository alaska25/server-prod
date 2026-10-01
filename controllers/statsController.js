import Order from "../models/Order.js";
import User from "../models/User.js";
import Book from "../models/Book.js";
import Template from "../models/Template.js";

const DAYS_BACK = 30;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Timezone used to decide which calendar day an order or signup belongs to.
// Default UTC (the previous behaviour). Set STATS_TIMEZONE to an IANA name such
// as "Asia/Tokyo" or "America/New_York" to bucket days in your own timezone.
const TZ = (() => {
  const tz = process.env.STATS_TIMEZONE || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    console.warn(`Invalid STATS_TIMEZONE "${tz}", using UTC`);
    return "UTC";
  }
})();

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayKey = (date) => dayFormatter.format(date); // "YYYY-MM-DD" in TZ

// Dashboard numbers don't need to be accurate to the second, so cache the
// full response briefly. Turns repeated visits/refreshes within the same
// minute into an instant response instead of re-running the aggregations
// every time.
let statsCache = { data: null, at: 0 };

// Called after an order is marked paid (see orderController.js) so the admin
// dashboard shows the new sale immediately instead of after the cache expires.
export const clearStatsCache = () => {
  statsCache = { data: null, at: 0 };
};

// Builds an array of the last `days` day-keys (oldest first), so charts get
// a continuous line even on days with zero orders/signups instead of gaps.
// Uses plain calendar arithmetic on today's date in TZ, so daylight-saving
// changes can never produce a duplicate or a missing day.
export const lastNDayKeys = (days, now = new Date()) => {
  const [y, m, d] = dayKey(now).split("-").map(Number);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return keys;
};

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// GET /stats/dashboard — superadmin-only, see statsRoutes.js.
export const getDashboardStats = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    if (statsCache.data && Date.now() - statsCache.at < CACHE_TTL_MS) {
      return res.json(statsCache.data);
    }

    // A little wider than the window (a day boundary in any timezone is within
    // 14h of UTC); only the day keys below are ever read from the results.
    const since = new Date(Date.now() - (DAYS_BACK + 2) * 24 * 60 * 60 * 1000);

    const byDay = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } };

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
        { $group: { _id: byDay, revenue: { $sum: "$totalAmount" } } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: byDay, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: "paid" } },
        { $unwind: "$books" },
        {
          $group: {
            _id: "$books.book",
            unitsSold: { $sum: 1 },
            revenue: { $sum: "$books.price" },
            snapshotTitle: { $first: "$books.title" },
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
        // Keep the row even if the book was deleted since the sale.
        { $unwind: { path: "$book", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            bookId: "$_id",
            title: { $ifNull: ["$book.title", { $ifNull: ["$snapshotTitle", "(deleted book)"] }] },
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
            snapshotTitle: { $first: "$templates.title" },
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
        { $unwind: { path: "$template", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            templateId: "$_id",
            title: {
              $ifNull: ["$template.title", { $ifNull: ["$snapshotTitle", "(deleted template)"] }],
            },
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
        activeUsers, // accounts that are not deactivated (not "active in the last 30 days")
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