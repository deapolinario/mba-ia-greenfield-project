import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      public_id: `pid${counter}`,
      channel_id: channel.id,
      title: 'My video',
      storage_key: `videos/pid${counter}/original`,
      ...overrides,
    };
  }

  it('should enforce unique constraint on public_id', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create(buildVideo(channel, { public_id: 'dup-id' })),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(await createChannel(), { public_id: 'dup-id' }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft when not explicitly set', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel)),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should accept every value in the status enum', async () => {
    const channel = await createChannel();
    const statuses = Object.values(VideoStatus);

    for (const status of statuses) {
      const saved = await videoRepository.save(
        videoRepository.create(
          buildVideo(channel, {
            public_id: `pid-${status}-${++counter}`,
            status,
          }),
        ),
      );
      expect(saved.status).toBe(status);
    }
  });

  it('should reject a status value outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "storage_key", "status")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `pid-bad-${++counter}`,
          channel.id,
          'Title',
          'videos/key/original',
          'bogus',
        ],
      ),
    ).rejects.toThrow();
  });

  it('should fail with FK violation when channel_id does not exist', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: `pid-nofk-${++counter}`,
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Title',
          storage_key: 'videos/key/original',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null thumbnail_key, duration_seconds, and metadata', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel, {
          thumbnail_key: null,
          duration_seconds: null,
          metadata: null,
        }),
      ),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
  });

  it('should auto-generate created_at and updated_at timestamps', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel)),
    );

    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });
});
