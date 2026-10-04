import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type CompletedPart,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './s3-client.provider';

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  buildStorageKey(publicId: string): string {
    return `videos/${publicId}/original`;
  }

  buildThumbnailKey(publicId: string): string {
    return `videos/${publicId}/thumbnail.jpg`;
  }

  async createMultipartUpload(key: string, contentType?: string) {
    const result = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return result.UploadId as string;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.s3Client, command, {
      expiresIn: this.config.presignUploadTtlSeconds,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ) {
    return this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    return this.s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<HeadObjectCommandOutput> {
    return this.s3Client.send(
      new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
    );
  }

  async presignGet(
    key: string,
    responseContentDisposition?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return getSignedUrl(this.s3Client, command, {
      expiresIn: this.config.presignDownloadTtlSeconds,
    });
  }

  async putObject(key: string, body: Buffer, contentType?: string) {
    return this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string) {
    return this.s3Client.send(
      new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
    );
  }
}
