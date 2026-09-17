import { S3Client } from "@aws-sdk/client-s3";

// Works with real AWS S3 or any S3-compatible provider
// (DigitalOcean Spaces, Backblaze B2, Cloudflare R2, etc.)
// by setting S3_ENDPOINT in .env.
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

export default s3;
