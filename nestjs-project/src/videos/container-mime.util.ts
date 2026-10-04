// ffprobe's format_name is a fixed string per demuxer, shared by container
// families that are structurally the same format: QuickTime and MP4 are both
// ISO base media containers (ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2" for
// either), and WebM is a restricted profile of Matroska (ffprobe reports
// "matroska,webm" for either). So "video/mp4" and "video/quicktime" share an
// expected format_name, and so do "video/webm" and "video/x-matroska" — this
// is not an approximation, it reflects the real container relationship.
const MIME_TO_FORMAT_NAMES: Record<string, string[]> = {
  'video/mp4': ['mov,mp4,m4a,3gp,3g2,mj2'],
  'video/quicktime': ['mov,mp4,m4a,3gp,3g2,mj2'],
  'video/webm': ['matroska,webm'],
  'video/x-matroska': ['matroska,webm'],
};

export function isContainerCompatibleWithMimeType(
  formatName: string,
  declaredMimeType: string,
): boolean {
  const expected = MIME_TO_FORMAT_NAMES[declaredMimeType];
  if (!expected) return false;
  return expected.includes(formatName);
}
