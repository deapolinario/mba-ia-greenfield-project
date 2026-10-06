import { Test, TestingModule } from '@nestjs/testing';
import { VideoProcessingProcessor } from '../videos/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('compiles and resolves the VideoProcessingProcessor against real DB, Redis and MinIO', () => {
    const processor = moduleRef.get(VideoProcessingProcessor);
    expect(processor).toBeDefined();
  });

  it('registers no HTTP controllers', async () => {
    const app = moduleRef.createNestApplication();
    await app.init();

    const httpServer = app.getHttpServer();
    // A fully controller-less Nest app has no routes registered on the
    // underlying Express router stack beyond framework defaults.
    const router = httpServer._events?.request?._router;
    const appRoutes = router?.stack?.filter((layer: any) => layer.route);
    expect(appRoutes ?? []).toHaveLength(0);

    await app.close();
  });
});
