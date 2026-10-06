import { Module } from '@nestjs/common';
import { s3ClientProvider } from './s3-client.provider';
import { StorageService } from './storage.service';

@Module({
  providers: [s3ClientProvider, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
