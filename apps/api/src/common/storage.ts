import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppConfig } from '../config';

/**
 * File storage. Files are addressed by key (e.g. `kyc/<orgId>/<id>.pdf`) and never get a direct URL: callers read
 * them back through API routes, which check who is asking for private files (KYC) and serve public ones (event
 * images under `event-images/`) to anyone. STORAGE_DRIVER picks the implementation;
 * only the local disk exists for now, an S3/R2 driver would implement the same three calls.
 */
export interface FileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The file's bytes, or null when nothing is stored under the key. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

/** Keeps files under one directory; for development and tests. */
export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  /** Keys are built by the API, but refuse anything that would land outside the root all the same. */
  private path(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return path;
  }
}

export function createStorage(config: Pick<AppConfig, 'STORAGE_DRIVER' | 'STORAGE_LOCAL_DIR'>): FileStorage {
  switch (config.STORAGE_DRIVER) {
    case 'local':
      return new LocalDiskStorage(config.STORAGE_LOCAL_DIR);
  }
}
