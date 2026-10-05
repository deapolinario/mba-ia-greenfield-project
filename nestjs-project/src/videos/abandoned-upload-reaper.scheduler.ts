import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AbandonedUploadReaper } from './abandoned-upload.reaper';

// No new scheduling library is introduced for a single periodic task —
// @nestjs/schedule isn't installed anywhere else in this project. A plain
// interval in the worker process is enough; BullMQ already owns the actual
// job queue (video-processing), which this maintenance sweep is unrelated to.
const REAPER_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class AbandonedUploadReaperScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AbandonedUploadReaperScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly reaper: AbandonedUploadReaper) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.reaper.run().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Abandoned-upload reaper run failed: ${message}`);
      });
    }, REAPER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
