import { Readable } from "node:stream";
import { Client } from "@replit/object-storage";

export class SponsorStorageError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly objectKey?: string,
  ) {
    super(message);
    this.name = "SponsorStorageError";
  }
}

export interface SponsorObjectStorage {
  put(objectKey: string, contents: Buffer): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
  stream(objectKey: string): Readable;
  delete(objectKey: string): Promise<void>;
}

export class ReplitSponsorObjectStorage implements SponsorObjectStorage {
  private client?: Client;

  private getClient(): Client {
    this.client ??= new Client();
    return this.client;
  }

  async put(objectKey: string, contents: Buffer): Promise<void> {
    const result = await this.getClient().uploadFromBytes(objectKey, contents, { compress: false });
    if (!result.ok) {
      throw new SponsorStorageError(result.error.message, "put", objectKey);
    }
  }

  async exists(objectKey: string): Promise<boolean> {
    const result = await this.getClient().exists(objectKey);
    if (!result.ok) {
      throw new SponsorStorageError(result.error.message, "exists", objectKey);
    }
    return result.value;
  }

  stream(objectKey: string): Readable {
    return this.getClient().downloadAsStream(objectKey);
  }

  async delete(objectKey: string): Promise<void> {
    const result = await this.getClient().delete(objectKey, { ignoreNotFound: true });
    if (!result.ok) {
      throw new SponsorStorageError(result.error.message, "delete", objectKey);
    }
  }
}

export class MemorySponsorObjectStorage implements SponsorObjectStorage {
  private readonly objects = new Map<string, Buffer>();

  async put(objectKey: string, contents: Buffer): Promise<void> {
    this.objects.set(objectKey, Buffer.from(contents));
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  stream(objectKey: string): Readable {
    const value = this.objects.get(objectKey);
    if (!value) {
      const stream = new Readable({ read() {} });
      queueMicrotask(() =>
        stream.destroy(new SponsorStorageError("Object not found", "stream", objectKey)),
      );
      return stream;
    }
    return Readable.from(Buffer.from(value));
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  readForTest(objectKey: string): Buffer | undefined {
    const value = this.objects.get(objectKey);
    return value ? Buffer.from(value) : undefined;
  }
}

let overrideStorage: SponsorObjectStorage | undefined;
let defaultStorage: SponsorObjectStorage | undefined;

export function getSponsorObjectStorage(): SponsorObjectStorage {
  if (overrideStorage) return overrideStorage;
  if (!defaultStorage) {
    defaultStorage =
      process.env.SPONSOR_STORAGE_ADAPTER === "memory"
        ? new MemorySponsorObjectStorage()
        : new ReplitSponsorObjectStorage();
  }
  return defaultStorage;
}

export function setSponsorObjectStorageForTests(storage?: SponsorObjectStorage): void {
  overrideStorage = storage;
}

export function sponsorObjectKey(sponsorId: number, assetId: string, version: number): string {
  const configuredPrefix = (process.env.SPONSOR_STORAGE_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const base = `sponsors/${sponsorId}/${assetId}/${version}`;
  return configuredPrefix ? `${configuredPrefix}/${base}` : base;
}
