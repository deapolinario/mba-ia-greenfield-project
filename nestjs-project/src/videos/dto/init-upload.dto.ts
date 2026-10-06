import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class InitUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  // Upper bound (10 GiB) is enforced in VideosService as a domain check
  // (VIDEO_SIZE_EXCEEDS_LIMIT), not here — the schema only validates shape.
  @IsInt()
  @Min(1)
  size_bytes: number;

  @IsString()
  @MinLength(1)
  mime_type: string;
}
