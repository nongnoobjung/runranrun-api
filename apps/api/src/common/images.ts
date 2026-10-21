import sharp from 'sharp';
import { ProblemException } from './problem';

/** Largest upload accepted before resizing; phone photos are usually 2–6 MB. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Longest edge kept after resizing: sharp enough for a full-width cover on a large screen. */
const MAX_EDGE = 2000;
/** Refuse decompression bombs (a tiny file that expands to billions of pixels) before decoding. */
const MAX_INPUT_PIXELS = 50_000_000;

const SIGNATURES: { type: string; matches: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** JPG, PNG or WebP, judged from the bytes rather than the file name or the type the browser sent. */
export function sniffImageType(body: Buffer): string | null {
  return SIGNATURES.find((s) => body.length >= 12 && s.matches(body))?.type ?? null;
}

export interface PreparedImage {
  body: Buffer;
  contentType: 'image/webp';
  width: number;
  height: number;
}

/**
 * Turns an upload into what the public page serves: upright (EXIF orientation applied), at most MAX_EDGE on the long
 * side with the aspect ratio kept, re-encoded as WebP. Re-encoding also drops EXIF, so a phone photo's GPS position
 * never reaches the public.
 */
export async function prepareImage(body: Buffer): Promise<PreparedImage> {
  if (body.length === 0) throw new ProblemException(422, 'EMPTY_FILE', 'The file is empty');
  if (body.length > IMAGE_MAX_BYTES) throw new ProblemException(413, 'FILE_TOO_LARGE', 'Images can be at most 10 MB');
  if (!sniffImageType(body)) throw new ProblemException(415, 'UNSUPPORTED_IMAGE_TYPE', 'Upload a JPG, PNG or WebP image');
  try {
    const { data, info } = await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { body: data, contentType: 'image/webp', width: info.width, height: info.height };
  } catch {
    throw new ProblemException(422, 'INVALID_IMAGE', 'The image could not be read; try saving it again as JPG or PNG');
  }
}
