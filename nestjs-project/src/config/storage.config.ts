import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  s3Bucket: process.env.S3_BUCKET,
  s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '8388608',
    10,
  ),
  presignUploadTtlSeconds: parseInt(
    process.env.PRESIGN_UPLOAD_TTL_SECONDS || '3600',
    10,
  ),
  presignDownloadTtlSeconds: parseInt(
    process.env.PRESIGN_DOWNLOAD_TTL_SECONDS || '300',
    10,
  ),
  uploadMaxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  uploadAcceptedMimeTypes: (
    process.env.UPLOAD_ACCEPTED_MIME_TYPES ||
    'video/mp4,video/quicktime,video/webm,video/x-matroska'
  ).split(','),
  abandonedUploadCutoffHours: parseInt(
    process.env.ABANDONED_UPLOAD_CUTOFF_HOURS || '24',
    10,
  ),
}));
