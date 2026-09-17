import Review from "../models/Review.js";
import Book from "../models/Book.js";
import User from "../models/User.js";

const recalculateBookRating = async (bookId) => {
  const stats = await Review.aggregate([
    { $match: { book: bookId } },
    { $group: { _id: "$book", avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);

  const avgRating = stats[0]?.avgRating || 0;
  const reviewCount = stats[0]?.count || 0;

  await Book.findByIdAndUpdate(bookId, {
    avgRating: Math.round(avgRating * 10) / 10,
    reviewCount,
  });
};

// GET /api/books/:id/reviews
export const getReviews = async (req, res) => {
  try {
    const reviews = await Review.find({ book: req.params.id }).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/reviews (protected, must own the book)
export const createReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const bookId = req.params.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    if (!comment || !comment.trim()) {
      return res.status(400).json({ message: "A review comment is required" });
    }

    const book = await Book.findById(bookId);
    if (!book) return res.status(404).json({ message: "Book not found" });

    // Verified-purchase gate: free books count as "owned" once claimed;
    // paid books require it to be in the user's library.
    const user = await User.findById(req.user._id);
    const owns = user.library.some((id) => id.toString() === bookId);
    if (!owns) {
      return res.status(403).json({ message: "Only readers who own this book can leave a review" });
    }

    const existing = await Review.findOne({ book: bookId, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: "You've already reviewed this book" });
    }

    const review = await Review.create({
      book: bookId,
      user: req.user._id,
      userName: req.user.name,
      rating,
      comment: comment.trim(),
    });

    await recalculateBookRating(bookId);

    res.status(201).json(review);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "You've already reviewed this book" });
    }
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/books/:id/reviews/:reviewId (author or admin)
export const deleteReview = async (req, res) => {
  try {
    const review = await Review.findById(req.params.reviewId);
    if (!review) return res.status(404).json({ message: "Review not found" });

    const isAuthor = review.user.toString() === req.user._id.toString();
    if (!isAuthor && req.user.role !== "admin") {
      return res.status(403).json({ message: "You can only delete your own review" });
    }

    const bookId = review.book;
    await review.deleteOne();
    await recalculateBookRating(bookId);

    res.json({ message: "Review deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
