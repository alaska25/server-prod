import Book from "../models/Book.js";
import User from "../models/User.js";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3 from "../utils/s3.js";
import path from "path";

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// Fields the book cards / listing pages actually need. Keeping list
// responses small (no description, no file keys) makes them much faster.
const LIST_FIELDS =
  "title subtitle author category price isFree featured fileType coverUrl pageCount avgRating reviewCount createdAt";

// Never send the private book file location to the public.
// (fileUrl/fileKey are also `select: false` in the Book schema.)
const HIDE_PRIVATE = "-fileUrl -fileKey";

// Storefront visibility filter. `$ne: false` also matches books saved before
// the `published` field existed. Once every book has `published: true`
// (run the backfill in CHANGES.md), change this to `true` so the listing
// indexes are used fully (no in-memory sort).
const PUBLISHED_FILTER = { $ne: false };

const MAX_LIMIT = 50;

// Parses ?page and ?limit safely (defaults + upper cap).
const parsePaging = (page, limit, defaultLimit, maxLimit = MAX_LIMIT) => {
  const safeLimit = Math.min(Math.max(Number(limit) || defaultLimit, 1), maxLimit);
  const safePage = Math.max(Number(page) || 1, 1);
  return { safeLimit, safePage, skip: (safePage - 1) * safeLimit };
};

// ---- Small helpers --------------------------------------------------------

// Sends a safe error response. Validation problems are the client's fault (400);
// everything else is logged and answered with a generic message.
const handleError = (res, err, label) => {
  if (err?.name === "ValidationError") {
    return res.status(400).json({ message: Object.values(err.errors).map((e) => e.message).join(", ") });
  }
  if (err?.name === "CastError") {
    return res.status(400).json({ message: "Invalid value" });
  }
  console.error(`${label}:`, err);
  return res.status(500).json({ message: "Server error" });
};

// Best-effort S3 deletes; never throws.
const removeFromS3 = async (...keys) => {
  await Promise.all(
    keys.filter(Boolean).map(async (Key) => {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning:", s3Err.message);
      }
    })
  );
};

// Keys of files multer already uploaded for this request. Used to clean up
// when the request then fails, so orphaned files don't pile up in the bucket.
const uploadedKeys = (req) =>
  Object.values(req.files || {})
    .flat()
    .map((f) => f.key);

// Simple in-memory cache for the category list (rarely changes).
let categoriesCache = { data: null, at: 0 };
const CATEGORIES_TTL_MS = 5 * 60 * 1000;
const clearCategoriesCache = () => {
  categoriesCache = { data: null, at: 0 };
};

// Cache of signed sample URLs, so repeated previews reuse one URL (which the
// browser can then cache too) instead of generating a new one every time.
const sampleCache = new Map(); // bookId -> { data, expires }
const SAMPLE_CACHE_MS = 30 * 60 * 1000;
const SAMPLE_CACHE_MAX = 500;

const clearBookCaches = (id) => {
  clearCategoriesCache();
  if (id) sampleCache.delete(String(id));
};

// ---- Public listing -------------------------------------------------------

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
    query.published = PUBLISHED_FILTER;

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
    handleError(res, err, "getBooks");
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
    handleError(res, err, "getBooksAdmin");
  }
};

// GET /api/books/:id (public) - full detail of a PUBLISHED book, minus the
// private file location.
export const getBookById = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select(HIDE_PRIVATE).lean();
    if (!book || book.published === false) {
      return res.status(404).json({ message: "Book not found" });
    }
    res.json(book);
  } catch (err) {
    handleError(res, err, "getBookById");
  }
};

// GET /api/books/admin/:id (admin) - full detail including unpublished books
// (for the admin edit form). Still excludes the private file location; use
// GET /api/books/:id/file to download the book file.
export const getBookByIdAdmin = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ message: "Book not found" });
    res.json(book);
  } catch (err) {
    handleError(res, err, "getBookByIdAdmin");
  }
};

// ---- Access to book files -------------------------------------------------

// GET /api/books/:id/access (protected) - returns a time-limited signed URL
// to read/download the book file, only if the user owns it (or it's free).
// People who already own a book keep access even if it is later unpublished.
export const getBookAccess = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id)
      .select("+fileKey title isFree fileType published")
      .lean();
    if (!book) return res.status(404).json({ message: "Book not found" });

    // One lightweight query instead of loading the whole user document.
    const owns = await User.exists({ _id: req.user._id, library: book._id });

    if (book.published === false && !owns) {
      return res.status(404).json({ message: "Book not found" });
    }
    if (!book.isFree && !owns) {
      return res.status(403).json({ message: "You don't own this book yet" });
    }

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    res.json({ url: signedUrl, fileType: book.fileType, title: book.title });
  } catch (err) {
    handleError(res, err, "getBookAccess");
  }
};

// GET /api/books/:id/sample (public) - time-limited signed URL to the
// book's sample/preview file, if one has been uploaded.
export const getBookSample = async (req, res) => {
  try {
    const id = req.params.id;

    const hit = sampleCache.get(id);
    if (hit && hit.expires > Date.now()) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json(hit.data);
    }

    // Only the few fields needed, not the whole document.
    const book = await Book.findById(id).select("title sampleKey sampleFileType published").lean();
    if (!book || book.published === false) {
      return res.status(404).json({ message: "Book not found" });
    }
    if (!book.sampleKey) {
      return res.status(404).json({ message: "No sample is available for this book yet" });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: book.sampleKey,
      ResponseCacheControl: "public, max-age=3600",
    });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    const data = { url: signedUrl, fileType: book.sampleFileType, title: book.title };

    if (sampleCache.size >= SAMPLE_CACHE_MAX) sampleCache.clear();
    sampleCache.set(id, { data, expires: Date.now() + SAMPLE_CACHE_MS });

    res.set("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch (err) {
    handleError(res, err, "getBookSample");
  }
};

// GET /api/books/:id/file (admin) - signed URL to download the current book
// file regardless of ownership (used on the admin edit form).
export const getBookFileAdmin = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select("+fileKey title fileType").lean();
    if (!book) return res.status(404).json({ message: "Book not found" });

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: book.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 minutes

    res.json({ url: signedUrl, fileType: book.fileType, title: book.title });
  } catch (err) {
    handleError(res, err, "getBookFileAdmin");
  }
};

// ---- Admin file uploads ---------------------------------------------------
// Pattern for all three: save the new key first, and only then delete the old
// object, so a failed save can never leave the database pointing at a deleted
// file. If anything fails, the newly uploaded files are removed again.

// POST /api/books/:id/sample (admin) - single 'sampleFile' field.
export const uploadBookSample = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) {
      await removeFromS3(...uploadedKeys(req));
      return res.status(404).json({ message: "Book not found" });
    }

    const sampleFile = req.files?.sampleFile?.[0];
    if (!sampleFile) {
      return res.status(400).json({ message: "A sample file is required" });
    }

    const oldKey = book.sampleKey;
    const ext = path.extname(sampleFile.originalname).toLowerCase().replace(".", "");

    book.sampleKey = sampleFile.key;
    book.sampleUrl = sampleFile.location || publicUrl(sampleFile.key);
    book.sampleFileType = ext === "epub" ? "epub" : "pdf";

    const updated = await book.save();
    await removeFromS3(oldKey);
    clearBookCaches(book._id);

    res.json(updated);
  } catch (err) {
    await removeFromS3(...uploadedKeys(req));
    handleError(res, err, "uploadBookSample");
  }
};

// POST /api/books/:id/cover (admin) - single 'cover' field.
export const uploadBookCover = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) {
      await removeFromS3(...uploadedKeys(req));
      return res.status(404).json({ message: "Book not found" });
    }

    const coverFile = req.files?.cover?.[0];
    if (!coverFile) {
      return res.status(400).json({ message: "A cover image is required" });
    }

    const oldKey = book.coverKey;

    book.coverKey = coverFile.key;
    book.coverUrl = coverFile.location || publicUrl(coverFile.key);

    const updated = await book.save();
    await removeFromS3(oldKey);

    res.json(updated);
  } catch (err) {
    await removeFromS3(...uploadedKeys(req));
    handleError(res, err, "uploadBookCover");
  }
};

// POST /api/books/:id/file (admin) - single 'bookFile' field.
export const uploadBookFile = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select("+fileKey +fileUrl");
    if (!book) {
      await removeFromS3(...uploadedKeys(req));
      return res.status(404).json({ message: "Book not found" });
    }

    const bookFile = req.files?.bookFile?.[0];
    if (!bookFile) {
      return res.status(400).json({ message: "A book file is required" });
    }

    const oldKey = book.fileKey;
    const ext = path.extname(bookFile.originalname).toLowerCase().replace(".", "");

    book.fileKey = bookFile.key;
    book.fileUrl = bookFile.location || publicUrl(bookFile.key);
    book.fileType = ext === "epub" ? "epub" : "pdf";

    const updated = await book.save();
    await removeFromS3(oldKey);

    res.json(updated);
  } catch (err) {
    await removeFromS3(...uploadedKeys(req));
    handleError(res, err, "uploadBookFile");
  }
};

// ---- Claiming, categories -------------------------------------------------

// POST /api/books/:id/claim (protected) - grants a free book directly to the
// user's library without going through checkout.
export const claimFreeBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select("isFree published").lean();
    if (!book || book.published === false) {
      return res.status(404).json({ message: "Book not found" });
    }
    if (!book.isFree) {
      return res.status(400).json({ message: "This book is not free" });
    }

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { library: book._id } });
    res.json({ message: "Book added to your library" });
  } catch (err) {
    handleError(res, err, "claimFreeBook");
  }
};

// GET /api/books/categories - cached for a few minutes.
export const getCategories = async (req, res) => {
  try {
    if (categoriesCache.data && Date.now() - categoriesCache.at < CATEGORIES_TTL_MS) {
      return res.json(categoriesCache.data);
    }
    const categories = await Book.distinct("category", { published: PUBLISHED_FILTER });
    categoriesCache = { data: categories, at: Date.now() };
    res.json(categories);
  } catch (err) {
    handleError(res, err, "getCategories");
  }
};

// ---- Admin create / update / delete --------------------------------------

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
      await removeFromS3(...uploadedKeys(req));
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
      // A non-numeric price fails schema validation and returns 400.
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

    clearBookCaches();
    res.status(201).json(book);
  } catch (err) {
    await removeFromS3(...uploadedKeys(req));
    handleError(res, err, "createBook");
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

    const updated = await book.save(); // schema hook keeps free books at price 0
    clearBookCaches(book._id);
    res.json(updated);
  } catch (err) {
    handleError(res, err, "updateBook");
  }
};

// DELETE /api/books/:id (admin)
// A book that customers already own is never hard-deleted (that would remove
// files people paid for and leave dangling entries in their libraries). It is
// unpublished instead, which hides it from the storefront.
export const deleteBook = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id).select("+fileKey");
    if (!book) return res.status(404).json({ message: "Book not found" });

    const hasOwners = await User.exists({ library: book._id });
    if (hasOwners) {
      book.published = false;
      await book.save();
      clearBookCaches(book._id);
      return res.json({
        message: "This book has customers, so it was unpublished instead of deleted.",
        unpublished: true,
      });
    }

    await book.deleteOne();
    await removeFromS3(book.coverKey, book.fileKey, book.sampleKey);
    clearBookCaches(book._id);
    res.json({ message: "Book deleted" });
  } catch (err) {
    handleError(res, err, "deleteBook");
  }
};