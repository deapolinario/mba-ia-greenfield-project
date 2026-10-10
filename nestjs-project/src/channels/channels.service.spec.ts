import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

interface MockManager {
  findOne: jest.Mock<Promise<Channel | null>, [typeof Channel, unknown]>;
  create: jest.Mock<Channel, [typeof Channel, Partial<Channel>]>;
  save: jest.Mock<Promise<Channel>, [Channel]>;
}

function makeManager(overrides: Partial<MockManager> = {}): MockManager {
  return {
    findOne: jest.fn<Promise<Channel | null>, [typeof Channel, unknown]>(),
    create: jest.fn<Channel, [typeof Channel, Partial<Channel>]>(),
    save: jest.fn<Promise<Channel>, [Channel]>(),
    ...overrides,
  };
}

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

interface UniqueViolationError extends QueryFailedError {
  code: string;
  detail: string;
}

function makeUniqueError(): UniqueViolationError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as UniqueViolationError;
  err.code = '23505';
  err.detail = 'Key (nickname)=(abc) already exists.';
  return err;
}

interface MockDataSource {
  transaction: jest.Mock<
    Promise<Channel>,
    [(manager: EntityManager) => Promise<Channel>]
  >;
}

function makeDataSource(manager: MockManager): MockDataSource {
  return {
    transaction: jest.fn((cb: (manager: EntityManager) => Promise<Channel>) =>
      cb(manager as unknown as EntityManager),
    ),
  };
}

describe('ChannelsService', () => {
  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockResolvedValue(channel),
      });
      const service = new ChannelsService(
        makeDataSource(manager) as unknown as DataSource,
        {} as unknown as Repository<Channel>,
      );

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager.findOne).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(colliding)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest.fn().mockResolvedValue(resolved),
      });
      const service = new ChannelsService(
        makeDataSource(manager) as unknown as DataSource,
        {} as unknown as Repository<Channel>,
      );

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager.findOne).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved),
      });
      const service = new ChannelsService(
        makeDataSource(manager) as unknown as DataSource,
        {} as unknown as Repository<Channel>,
      );

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn(),
      });
      const service = new ChannelsService(
        makeDataSource(manager) as unknown as DataSource,
        {} as unknown as Repository<Channel>,
      );

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockRejectedValue(unexpectedError),
      });
      const service = new ChannelsService(
        makeDataSource(manager) as unknown as DataSource,
        {} as unknown as Repository<Channel>,
      );

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager.save).toHaveBeenCalledTimes(1);
    });
  });
});
