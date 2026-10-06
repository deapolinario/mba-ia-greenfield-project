import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { isContainerCompatibleWithMimeType } from './container-mime.util';
import { Video, VideoStatus } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import type { VideoProcessingJobPayload } from './video-processing.job';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  async process(job: Job<VideoProcessingJobPayload>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      throw new Error(`Video ${job.data.videoId} not found`);
    }

    try {
      await this.runPipeline(video);
    } catch (err) {
      const attemptsMade = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      if (attemptsMade < maxAttempts) {
        throw err;
      }

      video.status = VideoStatus.FAILED;
      video.processing_error = err instanceof Error ? err.message : String(err);
      video.duration_seconds = null;
      video.metadata = null;
      video.thumbnail_key = null;
      await this.videoRepository.save(video);
    }
  }

  private async runPipeline(video: Video): Promise<void> {
    const sourceUrl = await this.storageService.presignGet(video.storage_key);

    const { durationSeconds, metadata } =
      await this.ffmpegService.probe(sourceUrl);

    if (
      !isContainerCompatibleWithMimeType(
        metadata.container,
        video.declared_mime_type ?? '',
      )
    ) {
      throw new Error(
        `Probed container "${metadata.container}" does not match declared MIME type "${video.declared_mime_type}"`,
      );
    }

    const thumbnailPath = path.join(
      os.tmpdir(),
      `${video.public_id}-thumbnail.jpg`,
    );
    await this.ffmpegService.generateThumbnail(sourceUrl, thumbnailPath);
    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    const thumbnailKey = this.storageService.buildThumbnailKey(video.public_id);
    await this.storageService.putObject(
      thumbnailKey,
      thumbnailBuffer,
      'image/jpeg',
    );
    await fs.unlink(thumbnailPath).catch((err: unknown) => {
      // Background-job cleanup failure — logged, not rethrown, per the
      // project's background-task error-handling exception.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to remove temp thumbnail file: ${message}`);
    });

    video.duration_seconds = durationSeconds;
    video.metadata = metadata;
    video.thumbnail_key = thumbnailKey;
    video.status = VideoStatus.READY;
    video.processing_error = null;
    await this.videoRepository.save(video);
  }
}
