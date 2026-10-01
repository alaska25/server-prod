import { S3Client } from "@aws-sdk/client-s3";

// Works with real AWS S3 or any S3-compatible provider
// (DigitalOcean Spaces, Backblaze B2, Cloudflare R2, etc.)
// by setting S3_ENDPOINT in .env.
//
// S3_REGION: real AWS region (e.g. "ap-northeast-1"); "auto" for Cloudflare R2;
// the provider's own region string for B2 / Spaces.
const hasKeys = process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY;

const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  maxAttempts: 3,
  // Newer SDK versions add checksums that some S3-compatible providers reject.
  // Harmless on AWS; ignored by SDK versions that don't know these options.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  // Only pass explicit credentials when both are set, so the SDK's default
  // credential chain (e.g. an IAM role) still works otherwise.
  ...(hasKeys
    ? {
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

export default s3;