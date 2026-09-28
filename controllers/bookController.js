import Book from "../models/Book.js";
import User from "../models/User.js";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3 from "../utils/s3.js";
import path from "path";

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// Fields the book cards / listing pages actually need. Keeping list
// responses small (no description, no file keys) makes them much faster.
// If a listing page shows something not in this list, add it here.
const LIST_FIELDS =
  "title subtitle author category price isFree featured fileType coverUrl pageCount avgRating reviewCount createdAt";

// Never send the private book file location to the public.
const HIDE_PRIVATE = "-fileUrl -fileKey";

const MAX_LIMIT = 50;

// Parses ?page and ?limit safely (defaults + upper cap).
const parsePaging = (page, limit, defaultLimit, maxLimit = MAX_LIMIT) => {
  const safeLimit = Math.min(Math.max(Number(limit) || defaultLimit, 1), maxLimit);
  const safePage = Math.max(Number(page) || 1, 1);
  return { safeLimit, safePage, skip: (safePage - 1) * safeLimit };
};

// Simple in-memory cache for the category list (rarely changes).
let categoriesCache = { data: null, at: 0 };
const CATEGORIES_TTL_MS = 5 * 60 * 1000;
const clearCategoriesCache = () => {
  categoriesCache = { data: null, at: 0 };
};

// GET /api/books?search=&category=&free=&page=&limit=
export const getBooks = async (req, res) => {
  try {
    const { search, category, free, page, limit } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    // Searching for exactly "free" (what the "Start with a Free Title"
    // buttons send) means "show free books", not a text match. `?free=true`
    // does the same thing and can be combined with a category.
    const wantsFree = free === "true" || term.toLowerCase() === "free";

    if (term && term.toLowerCase() !== "free") {
      query.$text = { $search: term };
    }
    if (typeof category === "string" && category) {
      query.category = category;
    }
    if (wantsFree) {
      query.isFree = true;
    }
    // Hide unpublished books. Uses $ne so books saved before this field
    // existed still show. Once every book has `published: true` (see the
    // backfill note in the README/chat), change this to `= true` so the
    // index can be used more efficiently.
    query.published = { $ne: false };

    const { safeLimit, safePage, skip } = parsePaging(page, limit, 12);

    const [books, total] = await Promise.all([
      Book.find(query)
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Book.countDocuments(query),
    ]);

    res.json({ books, total, page: safePage, pages: Math.ceil(total / safeLimit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/books/admin (admin) - same shape as the public listing, but
// returns every book regardless of published status.
export const getBooksAdmin = async (req, res) => {
  try {
    const { search, category, page, limit } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    if (term) {
      query.$text = { $search: term };
    }
    if (typeof category === "string" && category) {
      query.category = category;
    }

    const { safeLimit, safePage, skip } = parsePaging(page, limit, 100, 200);

    const [books, total] = await Promise.all([
      Book.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
      Book.countDocuments(query),
    ]);

    res.json({ books, total, page: safePage, pages: Math.ceil(total / safeLimit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/books/:id (public) - full detail, minus the private file location.
// NOTE: if your admin edit form reads fileUrl/fileKey from this endpoint,
// use the admin download route (GET /api/books/:id/file) instead.
export const getBookById = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select(HIDE_PRIVATE).lean();
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
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ message: "Book not found" });

    if (!book.isFree) {
      // One lightweight query instead of loading the whole user document.
      const owns = await User.exists({ _id: req.user._id, library: book._id });
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

// GET /api/books/:id/sample (public) - time-limited signed URL to the
// book's sample/preview file, if one has been uploaded.
export const getBookSample = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ message: "Book not found" });

    if (!book.sampleKey) {
      return res.status(404).json({ message: "No sample is available for this book yet" });
    }

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.sampleKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    res.json({ url: signedUrl, fileType: book.sampleFileType, title: book.title });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/sample (admin) - expects multipart/form-data with a
// single 'sampleFile' field. Replaces any existing sample for this book.
export const uploadBookSample = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    const sampleFile = req.files?.sampleFile?.[0];
    if (!sampleFile) {
      return res.status(400).json({ message: "A sample file is required" });
    }

    // Best-effort cleanup of the previous sample, if any.
    if (book.sampleKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.sampleKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old sample):", s3Err.message);
      }
    }

    const ext = path.extname(sampleFile.originalname).toLowerCase().replace(".", "");

    book.sampleKey = sampleFile.key;
    book.sampleUrl = sampleFile.location || publicUrl(sampleFile.key);
    book.sampleFileType = ext === "epub" ? "epub" : "pdf";

    const updated = await book.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/books/:id/file (admin) - signed URL to download the current book
// file regardless of ownership (used on the admin edit form).
export const getBookFileAdmin = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ message: "Book not found" });

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 minutes

    res.json({ url: signedUrl, fileType: book.fileType, title: book.title });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/cover (admin) - single 'cover' field.
export const uploadBookCover = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    const coverFile = req.files?.cover?.[0];
    if (!coverFile) {
      return res.status(400).json({ message: "A cover image is required" });
    }

    // Best-effort cleanup of the previous cover.
    if (book.coverKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.coverKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old cover):", s3Err.message);
      }
    }

    book.coverKey = coverFile.key;
    book.coverUrl = coverFile.location || publicUrl(coverFile.key);

    const updated = await book.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/file (admin) - single 'bookFile' field.
export const uploadBookFile = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    const bookFile = req.files?.bookFile?.[0];
    if (!bookFile) {
      return res.status(400).json({ message: "A book file is required" });
    }

    // Best-effort cleanup of the previous file.
    if (book.fileKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old book file):", s3Err.message);
      }
    }

    const ext = path.extname(bookFile.originalname).toLowerCase().replace(".", "");

    book.fileKey = bookFile.key;
    book.fileUrl = bookFile.location || publicUrl(bookFile.key);
    book.fileType = ext === "epub" ? "epub" : "pdf";

    const updated = await book.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books/:id/claim (protected) - grants a free book directly to the
// user's library without going through Stripe checkout.
export const claimFreeBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select("isFree").lean();
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

// GET /api/books/categories - cached for a few minutes.
export const getCategories = async (req, res) => {
  try {
    if (categoriesCache.data && Date.now() - categoriesCache.at < CATEGORIES_TTL_MS) {
      return res.json(categoriesCache.data);
    }
    const categories = await Book.distinct("category");
    categoriesCache = { data: categories, at: Date.now() };
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/books (admin) - multipart/form-data with 'cover' and 'bookFile',
// and optionally a 'sampleFile' to seed the preview at creation time.
export const createBook = async (req, res) => {
  try {
    const {
      title,
      subtitle,
      author,
      description,
      category,
      price,
      isFree,
      featured,
      pageCount,
      publishedAt,
    } = req.body;
    const coverFile = req.files?.cover?.[0];
    const bookFile = req.files?.bookFile?.[0];
    const sampleFile = req.files?.sampleFile?.[0];

    if (!coverFile || !bookFile) {
      return res.status(400).json({ message: "Cover image and book file are both required" });
    }

    const ext = path.extname(bookFile.originalname).toLowerCase().replace(".", "");

    const sampleFields = sampleFile
      ? {
          sampleKey: sampleFile.key,
          sampleUrl: sampleFile.location || publicUrl(sampleFile.key),
          sampleFileType:
            path.extname(sampleFile.originalname).toLowerCase().replace(".", "") === "epub"
              ? "epub"
              : "pdf",
        }
      : {};

    const book = await Book.create({
      title,
      subtitle,
      author,
      description,
      category,
      price: isFree === "true" ? 0 : Number(price),
      isFree: isFree === "true",
      featured: featured === "true",
      // Both optional: only set when the admin form actually sent a value,
      // so an empty string doesn't get coerced into 0 or an invalid Date.
      ...(pageCount !== undefined && pageCount !== "" ? { pageCount: Number(pageCount) } : {}),
      ...(publishedAt !== undefined && publishedAt !== "" ? { publishedAt: new Date(publishedAt) } : {}),
      coverUrl: coverFile.location || publicUrl(coverFile.key),
      coverKey: coverFile.key,
      fileUrl: bookFile.location || publicUrl(bookFile.key),
      fileKey: bookFile.key,
      fileType: ext === "epub" ? "epub" : "pdf",
      ...sampleFields,
    });

    clearCategoriesCache();
    res.status(201).json(book);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/books/:id (admin) - text fields only; use the separate routes
// for replacing files.
export const updateBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ message: "Book not found" });

    const {
      title,
      subtitle,
      author,
      description,
      category,
      price,
      isFree,
      featured,
      pageCount,
      publishedAt,
      published,
    } = req.body;
    if (title !== undefined) book.title = title;
    if (subtitle !== undefined) book.subtitle = subtitle;
    if (author !== undefined) book.author = author;
    if (description !== undefined) book.description = description;
    if (category !== undefined) book.category = category;
    if (price !== undefined) book.price = Number(price);
    if (isFree !== undefined) book.isFree = isFree === "true" || isFree === true;
    if (featured !== undefined) book.featured = featured === "true" || featured === true;
    // Empty string clears the field back to unset; any other value sets it.
    if (pageCount !== undefined) book.pageCount = pageCount === "" ? undefined : Number(pageCount);
    if (publishedAt !== undefined) book.publishedAt = publishedAt === "" ? undefined : new Date(publishedAt);
    if (published !== undefined) book.published = published === "true" || published === true;

    const updated = await book.save();
    clearCategoriesCache();
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
      if (book.sampleKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.sampleKey }));
      }
    } catch (s3Err) {
      console.warn("S3 cleanup warning:", s3Err.message);
    }

    await book.deleteOne();
    clearCategoriesCache();
    res.json({ message: "Book deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};