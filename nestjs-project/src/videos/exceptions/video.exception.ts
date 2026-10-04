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

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'No video matches the given public id');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_OWNED',
      403,
      'The authenticated user does not own the channel this video belongs to',
    );
  }
}

export class VideoInvalidStateTransitionException extends DomainException {
  constructor() {
    super(
      'VIDEO_INVALID_STATE_TRANSITION',
      409,
      'The video is not in a state that allows this operation',
    );
  }
}

export class VideoUploadCompletionFailedException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_COMPLETION_FAILED',
      502,
      'The storage rejected the multipart upload completion',
    );
  }
}
