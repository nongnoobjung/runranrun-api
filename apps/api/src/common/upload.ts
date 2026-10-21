import { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemException } from './problem';

/** A private file read back from storage, ready to send. */
export interface StoredFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

export interface Upload {
  fields: Record<string, string>;
  file: { body: Buffer; fileName: string } | null;
}

/** Reads a multipart/form-data body with at most one file of `maxBytes` and a few short text fields. */
export async function readUpload(req: FastifyRequest, maxBytes: number): Promise<Upload> {
  if (!req.isMultipart()) throw new ProblemException(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as multipart/form-data');
  const upload: Upload = { fields: {}, file: null };
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1000 } })) {
      if (part.type === 'file') upload.file = { body: await part.toBuffer(), fileName: part.filename };
      else upload.fields[part.fieldname] = String(part.value);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new ProblemException(413, 'FILE_TOO_LARGE', `Files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB`);
    if (code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') {
      throw new ProblemException(413, 'TOO_MANY_PARTS', 'Send one file at a time');
    }
    throw err;
  }
  return upload;
}

/** Sends a stored private file inline; it must never be cached by a browser or proxy. */
export function sendFile(reply: FastifyReply, file: StoredFile): Buffer {
  void reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff');
  return file.body;
}
