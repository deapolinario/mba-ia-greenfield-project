import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService.initUpload (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidsvc${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  it('persists a row in uploading with upload_id and storage_key populated', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await service.initUpload(userId, {
      title: 'My video',
      size_bytes: 1024,
      mime_type: 'video/mp4',
    });

    expect(result.status).toBe('uploading');
    expect(result.parts.length).toBeGreaterThan(0);

    const row = await videoRepository.findOneBy({
      public_id: result.public_id,
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('uploading');
    expect(row!.channel_id).toBe(channelId);
    expect(row!.storage_key).toBe(`videos/${result.public_id}/original`);
    expect(row!.upload_id).toBe(result.upload_id);
  }, 30000);
});
