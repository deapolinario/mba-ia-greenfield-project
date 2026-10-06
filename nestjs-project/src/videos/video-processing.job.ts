export const VIDEO_PROCESSING_JOB_NAME = 'video-processing.process';

export interface VideoProcessingJobPayload {
  videoId: string;
  publicId: string;
  storageKey: string;
}
