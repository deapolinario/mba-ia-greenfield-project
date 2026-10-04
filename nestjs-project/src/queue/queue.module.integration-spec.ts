import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule, VIDEO_PROCESSING_QUEUE } from './queue.module';

describe('QueueModule', () => {
  let queue: Queue;
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('should compile with forRootAsync + registerQueue connecting to Redis', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
  });

  it('should make an enqueued job visible in the video-processing queue', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.add('video-processing.process', {
      videoId: 'id',
      publicId: 'pid',
      storageKey: 'videos/pid/original',
    });

    const counts = await queue.getJobCounts('waiting', 'delayed');
    expect(counts.waiting + counts.delayed).toBeGreaterThan(0);
  });
});
