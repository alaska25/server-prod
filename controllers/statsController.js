import Order from "../models/Order.js";
import User from "../models/User.js";
import Book from "../models/Book.js";

const DAYS_BACK = 30;

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

// GET /stats/dashboard — superadmin-only, see statsRoutes.js.
export const getDashboardStats = async (req, res) => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (DAYS_BACK - 1));
  since.setUTCHours(0, 0, 0, 0);

  const [
    revenueAgg,
    totalOrders,
    activeUsers,
    totalBooks,
    revenueByDayRaw,
    userGrowthRaw,
    topBooksRaw,
    orderStatusRaw,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Order.countDocuments(),
    User.countDocuments({ isActive: { $ne: false } }),
    Book.countDocuments(),
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
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  // Fill every day in the window, defaulting to 0 where there's no data.
  const dayKeys = lastNDayKeys(DAYS_BACK);
  const revenueByDate = Object.fromEntries(revenueByDayRaw.map((r) => [r._id, r.revenue]));
  const revenueByDay = dayKeys.map((date) => ({
    date,
    revenue: Math.round((revenueByDate[date] || 0) * 100) / 100,
  }));

  const signupsByDate = Object.fromEntries(userGrowthRaw.map((r) => [r._id, r.count]));
  const userGrowthByDay = dayKeys.map((date) => ({
    date,
    count: signupsByDate[date] || 0,
  }));

  const orderStatus = orderStatusRaw.map((r) => ({ status: r._id, count: r.count }));

  res.json({
    totals: {
      totalRevenue: Math.round((revenueAgg[0]?.total || 0) * 100) / 100,
      totalOrders,
      activeUsers,
      totalBooks,
    },
    revenueByDay,
    userGrowthByDay,
    topBooks: topBooksRaw,
    orderStatus,
  });
};