import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';

@Injectable()
export class AbandonedUploadReaper {
  private readonly logger = new Logger(AbandonedUploadReaper.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  // The draft/uploading split (per phase-03-videos/TD-10) is what makes this
  // query safe: only rows with bytes actually in flight are ever touched,
  // never a legitimate draft of any age.
  async run(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.config.abandonedUploadCutoffHours * 60 * 60 * 1000,
    );

    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.UPLOADING, updated_at: LessThan(cutoff) },
    });

    for (const video of abandoned) {
      try {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id as string,
        );
        video.status = VideoStatus.DRAFT;
        video.upload_id = null;
        await this.videoRepository.save(video);
      } catch (err) {
        // Background-job failure for one row — logged, not rethrown, so the
        // reaper still processes the remaining rows and the next scheduled
        // run retries this one (per the project's background-task
        // error-handling exception).
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to reap abandoned upload ${video.public_id}: ${message}`,
        );
      }
    }
  }
}
