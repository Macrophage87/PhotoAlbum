import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { RemoteMissingError, type RemoteClass, type RemoteObjects } from "./remote";

function isMissing(err: unknown): boolean {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode === 404 || err.name === "NotFound" || err.name === "NoSuchKey";
  return false;
}

/**
 * One S3 bucket. Credentials and region come from the usual AWS chain: on the album's EC2 server that is the
 * instance's role (see infra/option2-tiered-originals), so no keys are kept in .env.
 */
export class S3Objects implements RemoteObjects {
  private client: S3Client;

  constructor(private bucket: string, client?: S3Client) {
    this.client = client ?? new S3Client({});
  }

  async upload(key: string, file: string, opts: { storageClass: RemoteClass; contentType?: string; mtimeMs?: number }): Promise<void> {
    // Multipart for anything large (clips and scans run to a gigabyte). The SDK sends a CRC checksum with every part
    // and S3 refuses one that arrives different, so what lands is what was read.
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(file),
        StorageClass: opts.storageClass,
        ContentType: opts.contentType,
        Metadata: opts.mtimeMs ? { "album-mtime": String(Math.round(opts.mtimeMs)) } : undefined,
      },
      queueSize: 2,
      partSize: 16 * 1024 * 1024,
    }).done();
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const mtime = Number(r.Metadata?.["album-mtime"]);
      return { size: r.ContentLength ?? 0, storageClass: r.StorageClass ?? "STANDARD", mtimeMs: Number.isFinite(mtime) && mtime > 0 ? mtime : undefined };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async get(key: string, range?: { start: number; end: number }) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
      // "bytes 0-99/1234": the whole object's size is after the slash.
      const total = r.ContentRange ? Number(r.ContentRange.split("/")[1]) : r.ContentLength;
      return { stream: r.Body as Readable, size: total ?? 0 };
    } catch (err) {
      if (isMissing(err)) throw new RemoteMissingError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith("/")) throw new Error(`Refusing to delete remote prefix "${prefix}": it must end in "/"`);
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        const r = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        if (r.Errors?.length) throw new Error(`Could not delete ${r.Errors.length} object(s) under ${prefix}: ${r.Errors[0].Code} ${r.Errors[0].Message}`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
