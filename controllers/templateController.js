import Template from "../models/Template.js";
import User from "../models/User.js";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import s3 from "../utils/s3.js";
import { inspectZip } from "../utils/zipInspect.js";

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

// Fields the template cards / listing pages need. Deliberately excludes the
// heavy `readme` and `fileTree`, and the private file location.
const LIST_FIELDS =
  "title tagline category techStack version price isFree featured coverUrl createdAt";

const MAX_LIMIT = 50;

const parsePaging = (page, limit, defaultLimit, maxLimit = MAX_LIMIT) => {
  const safeLimit = Math.min(Math.max(Number(limit) || defaultLimit, 1), maxLimit);
  const safePage = Math.max(Number(page) || 1, 1);
  return { safeLimit, safePage, skip: (safePage - 1) * safeLimit };
};

// Safe download filename from the template title.
const zipName = (title) => `${String(title || "template").replace(/[^\w.-]+/g, "_")}.zip`;

// Simple in-memory cache for the category list (rarely changes).
let categoriesCache = { data: null, at: 0 };
const CATEGORIES_TTL_MS = 5 * 60 * 1000;
const clearCategoriesCache = () => {
  categoriesCache = { data: null, at: 0 };
};

// Uploads a buffer (from memory-storage multer) to S3 and returns its key/url.
// folder: "covers" | "templates"
async function uploadBufferToS3(buffer, originalName, contentType, folder) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const ext = originalName.slice(originalName.lastIndexOf("."));
  const key = `${folder}/${unique}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return { key, url: publicUrl(key) };
}

// Resizes a cover image to a small WebP before uploading.
async function uploadCoverToS3(buffer) {
  const optimized = await sharp(buffer)
    .rotate() // respect EXIF orientation
    .resize({ width: 800, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const key = `covers/${unique}.webp`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: optimized,
      ContentType: "image/webp",
      // Keys are unique per upload, so browsers/CDNs can cache forever.
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  return { key, url: publicUrl(key) };
}

// GET /api/templates?search=&category=&free=&page=&limit=
export const getTemplates = async (req, res) => {
  try {
    const { search, category, free, page, limit } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    const wantsFree = free === "true" || term.toLowerCase() === "free";

    if (term && term.toLowerCase() !== "free") {
      query.$text = { $search: term };
    }
    if (typeof category === "string" && category) query.category = category;
    if (wantsFree) query.isFree = true;
    query.published = { $ne: false };

    const { safeLimit, safePage, skip } = parsePaging(page, limit, 12);

    const [templates, total] = await Promise.all([
      Template.find(query)
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Template.countDocuments(query),
    ]);

    res.json({ templates, total, page: safePage, pages: Math.ceil(total / safeLimit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/admin (admin) - every template regardless of published status
export const getTemplatesAdmin = async (req, res) => {
  try {
    const { search, category, page, limit } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    if (term) query.$text = { $search: term };
    if (typeof category === "string" && category) query.category = category;

    const { safeLimit, safePage, skip } = parsePaging(page, limit, 100, 200);

    const [templates, total] = await Promise.all([
      Template.find(query)
        .select("-readme -fileTree") // the admin table doesn't need these
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Template.countDocuments(query),
    ]);

    res.json({ templates, total, page: safePage, pages: Math.ceil(total / safeLimit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/:id (public) - full detail minus the private file location.
// fileKey/fileUrl are `select: false` in the schema, so they are never returned
// unless asked for. We ask for fileKey only to compute `hasFile`, then drop it.
export const getTemplateById = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id).select("+fileKey").lean();
    if (!template) return res.status(404).json({ message: "Template not found" });

    template.hasFile = Boolean(template.fileKey?.trim());
    delete template.fileKey; // never send the private key to the client

    res.json(template);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/:id/access (protected) - signed download URL, only if
// the user owns it (or it's free).
export const getTemplateAccess = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id).select("+fileKey").lean();
    if (!template) return res.status(404).json({ message: "Template not found" });

    if (!template.isFree) {
      const owns = await User.exists({ _id: req.user._id, ownedTemplates: template._id });
      if (!owns) {
        return res.status(403).json({ message: "You don't own this template yet" });
      }
    }

    if (!template.fileKey?.trim()) {
      return res
        .status(404)
        .json({ message: "This template's file isn't available yet. Please contact support." });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: template.fileKey,
      ResponseContentDisposition: `attachment; filename="${zipName(template.title)}"`,
    });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    res.json({ url: signedUrl, fileType: template.fileType, title: template.title });
  } catch (err) {
    console.error("getTemplateAccess failed:", err);
    res.status(500).json({ message: "Could not create the download link" });
  }
};

// GET /api/templates/:id/file (admin) - download the current zip before replacing it
export const getTemplateFileAdmin = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id).select("+fileKey").lean();
    if (!template) return res.status(404).json({ message: "Template not found" });

    if (!template.fileKey?.trim()) {
      return res.status(404).json({ message: "This template has no file uploaded yet" });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: template.fileKey,
      ResponseContentDisposition: `attachment; filename="${zipName(template.title)}"`,
    });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 minutes

    res.json({ url: signedUrl, fileType: template.fileType, title: template.title });
  } catch (err) {
    console.error("getTemplateFileAdmin failed:", err);
    res.status(500).json({ message: "Could not create the download link" });
  }
};

// POST /api/templates/:id/cover (admin) - expects a buffer (memory storage)
export const uploadTemplateCover = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const coverFile = req.files?.cover?.[0];
    if (!coverFile) return res.status(400).json({ message: "A cover image is required" });

    const { key, url } = await uploadCoverToS3(coverFile.buffer);

    if (template.coverKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.coverKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old cover):", s3Err.message);
      }
    }

    template.coverKey = key;
    template.coverUrl = url;

    const updated = await template.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/templates/:id/file (admin) - expects a buffer (memory storage)
export const uploadTemplateFile = async (req, res) => {
  try {
    // +fileKey so we can delete the old zip from S3 when replacing it
    const template = await Template.findById(req.params.id).select("+fileKey +fileUrl");
    if (!template) return res.status(404).json({ message: "Template not found" });

    const templateFile = req.files?.templateFile?.[0];
    if (!templateFile) return res.status(400).json({ message: "A template zip file is required" });

    const { readme, fileTree } = inspectZip(templateFile.buffer);

    const { key, url } = await uploadBufferToS3(
      templateFile.buffer,
      templateFile.originalname,
      templateFile.mimetype,
      "templates"
    );

    const oldKey = template.fileKey;

    template.fileKey = key;
    template.fileUrl = url;
    template.fileType = "zip";
    template.readme = readme;
    template.fileTree = fileTree;

    await template.save();

    // Delete the old zip only after the new one is saved, so a failed save
    // never leaves the template without a file.
    if (oldKey && oldKey !== key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: oldKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old template file):", s3Err.message);
      }
    }

    // Don't send the private location back to the browser.
    const out = template.toObject();
    delete out.fileKey;
    delete out.fileUrl;
    res.json({ ...out, hasFile: true });
  } catch (err) {
    console.error("uploadTemplateFile failed:", err);
    res.status(500).json({ message: err.message });
  }
};

// POST /api/templates/:id/claim (protected) - free templates skip checkout
export const claimFreeTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id).select("isFree").lean();
    if (!template) return res.status(404).json({ message: "Template not found" });
    if (!template.isFree) return res.status(400).json({ message: "This template is not free" });

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { ownedTemplates: template._id } });
    res.json({ message: "Template added to your library" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/categories - cached for a few minutes.
export const getTemplateCategories = async (req, res) => {
  try {
    if (categoriesCache.data && Date.now() - categoriesCache.at < CATEGORIES_TTL_MS) {
      return res.json(categoriesCache.data);
    }
    const categories = await Template.distinct("category");
    categoriesCache = { data: categories, at: Date.now() };
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/templates (admin) - expects 'cover' and 'templateFile' as buffers
export const createTemplate = async (req, res) => {
  try {
    const { title, tagline, description, category, techStack, version, repoUrl, liveDemoUrl, price, isFree, featured } =
      req.body;
    const coverFile = req.files?.cover?.[0];
    const templateFile = req.files?.templateFile?.[0];

    if (!coverFile || !templateFile) {
      return res.status(400).json({ message: "Cover image and template zip are both required" });
    }

    const stackArray =
      typeof techStack === "string"
        ? techStack.split(",").map((s) => s.trim()).filter(Boolean)
        : Array.isArray(techStack)
        ? techStack
        : [];

    const { readme, fileTree } = inspectZip(templateFile.buffer);

    const [cover, file] = await Promise.all([
      uploadCoverToS3(coverFile.buffer),
      uploadBufferToS3(templateFile.buffer, templateFile.originalname, templateFile.mimetype, "templates"),
    ]);

    const template = await Template.create({
      title,
      tagline,
      description,
      category,
      techStack: stackArray,
      version,
      repoUrl,
      liveDemoUrl,
      price: isFree === "true" ? 0 : Number(price),
      isFree: isFree === "true",
      featured: featured === "true",
      coverUrl: cover.url,
      coverKey: cover.key,
      fileUrl: file.url,
      fileKey: file.key,
      fileType: "zip",
      readme,
      fileTree,
    });

    clearCategoriesCache();

    const out = template.toObject();
    delete out.fileKey;
    delete out.fileUrl;
    res.status(201).json({ ...out, hasFile: true });
  } catch (err) {
    console.error("createTemplate failed:", err);
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/templates/:id (admin) - text fields only
export const updateTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const {
      title, tagline, description, category, techStack, version, repoUrl,
      liveDemoUrl, price, isFree, featured, published,
    } = req.body;

    if (title !== undefined) template.title = title;
    if (tagline !== undefined) template.tagline = tagline;
    if (description !== undefined) template.description = description;
    if (category !== undefined) template.category = category;
    if (techStack !== undefined) {
      template.techStack =
        typeof techStack === "string"
          ? techStack.split(",").map((s) => s.trim()).filter(Boolean)
          : techStack;
    }
    if (version !== undefined) template.version = version;
    if (repoUrl !== undefined) template.repoUrl = repoUrl;
    if (liveDemoUrl !== undefined) template.liveDemoUrl = liveDemoUrl;
    if (price !== undefined) template.price = Number(price);
    if (isFree !== undefined) template.isFree = isFree === "true" || isFree === true;
    if (featured !== undefined) template.featured = featured === "true" || featured === true;
    if (published !== undefined) template.published = published === "true" || published === true;

    const updated = await template.save();
    clearCategoriesCache();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    // +fileKey so the zip is actually removed from S3
    const template = await Template.findById(req.params.id).select("+fileKey");
    if (!template) return res.status(404).json({ message: "Template not found" });

    // Delete each object separately so one failure doesn't skip the other.
    for (const key of [template.coverKey, template.fileKey]) {
      if (!key) continue;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning:", s3Err.message);
      }
    }

    await template.deleteOne();
    clearCategoriesCache();
    res.json({ message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};