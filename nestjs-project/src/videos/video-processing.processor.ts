import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import type { VideoProcessingJobPayload } from './video-processing.job';

// Concurrency is kept low (1-2) because the work this processor delegates to
// is CPU-bound (FFmpeg via child_process.spawn, per phase-03-videos/TD-07),
// not I/O-bound.
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  // The actual metadata extraction, thumbnail generation and status
  // transitions are implemented in SI-03.8. This SI only wires the worker
  // process and confirms a job can be consumed and marked completed.
  async process(job: Job<VideoProcessingJobPayload>): Promise<void> {
    this.logger.log(
      `Received job ${job.id} for video ${job.data.publicId} (storageKey=${job.data.storageKey})`,
    );
  }
}
