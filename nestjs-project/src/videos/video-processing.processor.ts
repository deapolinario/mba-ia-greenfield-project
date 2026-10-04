import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import type { VideoProcessingJobPayload } from './video-processing.job';
import { VideoProcessingService } from './video-processing.service';

// Concurrency is kept low (1-2) because the work this processor delegates to
// is CPU-bound (FFmpeg via child_process.spawn, per phase-03-videos/TD-07),
// not I/O-bound.
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobPayload>): Promise<void> {
    return this.videoProcessingService.process(job);
  }
}
