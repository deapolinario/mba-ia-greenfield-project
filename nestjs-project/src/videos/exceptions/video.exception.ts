import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoSizeExceedsLimitException extends DomainException {
  constructor() {
    super(
      'VIDEO_SIZE_EXCEEDS_LIMIT',
      400,
      'Declared or stored video size exceeds the allowed limit',
    );
  }
}

export class VideoMimeTypeNotAcceptedException extends DomainException {
  constructor() {
    super(
      'VIDEO_MIME_TYPE_NOT_ACCEPTED',
      400,
      'Declared MIME type is not in the accepted-formats allowlist',
    );
  }
}
