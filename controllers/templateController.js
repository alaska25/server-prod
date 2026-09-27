import Template from "../models/Template.js";
import User from "../models/User.js";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3 from "../utils/s3.js";
import { inspectZip } from "../utils/zipInspect.js";

const publicUrl = (key) => `${process.env.S3_PUBLIC_URL_BASE}/${key}`;

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

// GET /api/templates?search=&category=&free=&page=&limit=
export const getTemplates = async (req, res) => {
  try {
    const { search, category, free, page = 1, limit = 12 } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    const wantsFree = free === "true" || term.toLowerCase() === "free";

    if (term && term.toLowerCase() !== "free") {
      query.$text = { $search: term };
    }
    if (category) query.category = category;
    if (wantsFree) query.isFree = true;
    query.published = { $ne: false };

    const skip = (Number(page) - 1) * Number(limit);
    const [templates, total] = await Promise.all([
      Template.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Template.countDocuments(query),
    ]);

    res.json({ templates, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/admin (admin) - every template regardless of published status
export const getTemplatesAdmin = async (req, res) => {
  try {
    const { search, category, page = 1, limit = 100 } = req.query;
    const query = {};

    const term = typeof search === "string" ? search.trim() : "";
    if (term) query.$text = { $search: term };
    if (category) query.category = category;

    const skip = (Number(page) - 1) * Number(limit);
    const [templates, total] = await Promise.all([
      Template.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Template.countDocuments(query),
    ]);

    res.json({ templates, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getTemplateById = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });
    res.json(template);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/:id/access (protected) - signed download URL, only if
// the user owns it (or it's free). Mirrors getBookAccess exactly.
export const getTemplateAccess = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    if (!template.isFree) {
      const user = await User.findById(req.user._id);
      const owns = user.ownedTemplates.some((id) => id.toString() === template._id.toString());
      if (!owns) {
        return res.status(403).json({ message: "You don't own this template yet" });
      }
    }

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 }); // 1 hour

    res.json({ url: signedUrl, fileType: template.fileType, title: template.title });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/templates/:id/file (admin) - download the current zip before replacing it
export const getTemplateFileAdmin = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.fileKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 }); // 10 minutes

    res.json({ url: signedUrl, fileType: template.fileType, title: template.title });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/templates/:id/cover (admin) - now expects a buffer (memory storage)
export const uploadTemplateCover = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const coverFile = req.files?.cover?.[0];
    if (!coverFile) return res.status(400).json({ message: "A cover image is required" });

    const { key, url } = await uploadBufferToS3(
      coverFile.buffer,
      coverFile.originalname,
      coverFile.mimetype,
      "covers"
    );

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

// POST /api/templates/:id/file (admin) - now expects a buffer (memory storage)
export const uploadTemplateFile = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
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

    if (template.fileKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.fileKey }));
      } catch (s3Err) {
        console.warn("S3 cleanup warning (old template file):", s3Err.message);
      }
    }

    template.fileKey = key;
    template.fileUrl = url;
    template.fileType = "zip";
    template.readme = readme;
    template.fileTree = fileTree;

    const updated = await template.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/templates/:id/claim (protected) - free templates skip checkout
export const claimFreeTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });
    if (!template.isFree) return res.status(400).json({ message: "This template is not free" });

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { ownedTemplates: template._id } });
    res.json({ message: "Template added to your library" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getTemplateCategories = async (req, res) => {
  try {
    const categories = await Template.distinct("category");
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
      uploadBufferToS3(coverFile.buffer, coverFile.originalname, coverFile.mimetype, "covers"),
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

    res.status(201).json(template);
  } catch (err) {
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ message: "Template not found" });

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.coverKey }));
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: template.fileKey }));
    } catch (s3Err) {
      console.warn("S3 cleanup warning:", s3Err.message);
    }

    await template.deleteOne();
    res.json({ message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};