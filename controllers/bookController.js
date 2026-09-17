import Book from "../models/Book.js";
import User from "../models/User.js";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3 from "../utils/s3.js";
import path from "path";

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// GET /api/books?search=&category=&page=&limit=
export const getBooks = async (req, res) => {
  try {
    const { search, category, page = 1, limit = 12 } = req.query;
    const query = {};

    if (search) {
      query.$text = { $search: search };
    }
    if (category) {
      query.category = category;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [books, total] = await Promise.all([
      Book.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Book.countDocuments(query),
    ]);

    res.json({ books, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getBookById = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });
    res.json(book);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/books/:id/access (protected) - returns a time-limited signed URL
// to read/download the book file, only if the user owns it (or it's free).
export const getBookAccess = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    if (!book.isFree) {
      const user = await User.findById(req.user._id);
      const owns = user.library.some((id) => id.toString() === book._id.toString());
      if (!owns) {
        return res.status(403).json({ message: "You don't own this book yet" });
      }
    }

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    res.json({ url: signedUrl, fileType: book.fileType, title: book.title });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/claim (protected) - grants a free book directly to the
// user's library without going through Stripe checkout.
export const claimFreeBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });
    if (!book.isFree) {
      return res.status(400).json({ message: "This book is not free" });
    }

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { library: book._id } });
    res.json({ message: "Book added to your library" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getCategories = async (req, res) => {
  try {
    const categories = await Book.distinct("category");
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books (admin) - expects multipart/form-data with 'cover' and 'bookFile'
export const createBook = async (req, res) => {
  try {
    const { title, author, description, category, price, isFree, featured } = req.body;
    const coverFile = req.files?.cover?.[0];
    const bookFile = req.files?.bookFile?.[0];

    if (!coverFile || !bookFile) {
      return res.status(400).json({ message: "Cover image and book file are both required" });
    }

    const ext = path.extname(bookFile.originalname).toLowerCase().replace(".", "");

    const book = await Book.create({
      title,
      author,
      description,
      category,
      price: isFree === "true" ? 0 : Number(price),
      isFree: isFree === "true",
      featured: featured === "true",
      coverUrl: coverFile.location || publicUrl(coverFile.key),
      coverKey: coverFile.key,
      fileUrl: bookFile.location || publicUrl(bookFile.key),
      fileKey: bookFile.key,
      fileType: ext === "epub" ? "epub" : "pdf",
    });

    res.status(201).json(book);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/books/:id (admin) - text fields only; use separate routes for replacing files if needed
export const updateBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    const { title, author, description, category, price, isFree, featured } = req.body;
    if (title !== undefined) book.title = title;
    if (author !== undefined) book.author = author;
    if (description !== undefined) book.description = description;
    if (category !== undefined) book.category = category;
    if (price !== undefined) book.price = Number(price);
    if (isFree !== undefined) book.isFree = isFree === "true" || isFree === true;
    if (featured !== undefined) book.featured = featured === "true" || featured === true;

    const updated = await book.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    // Best-effort cleanup of S3 objects
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.coverKey }));
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey }));
    } catch (s3Err) {
      console.warn("S3 cleanup warning:", s3Err.message);
    }

    await book.deleteOne();
    res.json({ message: "Book deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
