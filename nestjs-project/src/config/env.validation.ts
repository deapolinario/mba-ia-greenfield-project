import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().default(6379),
  S3_ENDPOINT: Joi.string().required(),
  S3_REGION: Joi.string().required(),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  UPLOAD_PART_SIZE_BYTES: Joi.number().default(8388608),
  PRESIGN_UPLOAD_TTL_SECONDS: Joi.number().default(3600),
  PRESIGN_DOWNLOAD_TTL_SECONDS: Joi.number().default(300),
  UPLOAD_MAX_SIZE_BYTES: Joi.number().default(10737418240),
  UPLOAD_ACCEPTED_MIME_TYPES: Joi.string().default(
    'video/mp4,video/quicktime,video/webm,video/x-matroska',
  ),
});
