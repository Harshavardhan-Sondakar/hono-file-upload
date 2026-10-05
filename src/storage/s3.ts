import { DeleteObjectCommand, type PutObjectCommandInput, type S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { IncomingFile, Storage } from '../types'

export interface S3StorageOptions {
  /** Your `S3Client`. Point `endpoint` at R2, MinIO, etc. for S3-compatible storage. */
  client: S3Client
  bucket: string
  /**
   * Object key for the file. By default it's a random UUID plus the original
   * extension (if it looks safe), e.g. `3f2a...c1.png`.
   */
  key?: (file: Omit<IncomingFile, 'stream'>) => string | Promise<string>
  /** Extra `PutObject` params, e.g. `{ ACL: 'private', CacheControl: '...' }`. */
  params?: Omit<Partial<PutObjectCommandInput>, 'Bucket' | 'Key' | 'Body'>
  /** Size of each uploaded part in bytes. Default 5 MiB (the S3 minimum). */
  partSize?: number
  /** How many parts upload at the same time. Default 4. */
  queueSize?: number
}

export interface S3StorageResult {
  key: string
  bucket: string
  /** URL of the object, when S3 returns one. */
  location?: string
  etag?: string
}

export type S3Storage = Storage<S3StorageResult>

/**
 * Streams files to S3 (or any S3-compatible service) in parts, so large
 * uploads don't fill up memory. Needs `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`.
 */
export function s3Storage(options: S3StorageOptions): S3Storage {
  return {
    async save(file) {
      const { stream, ...info } = file
      const key = options.key ? await options.key(info) : randomKey(info.filename)

      const upload = new Upload({
        client: options.client,
        partSize: options.partSize,
        queueSize: options.queueSize ?? 4,
        params: {
          ContentType: info.type,
          ...options.params,
          Bucket: options.bucket,
          Key: key,
          Body: stream,
        },
      })
      const out = await upload.done()
      return {
        key,
        bucket: options.bucket,
        location: 'Location' in out ? out.Location : undefined,
        etag: out.ETag,
      }
    },

    async remove(saved) {
      await options.client.send(new DeleteObjectCommand({ Bucket: saved.bucket, Key: saved.key }))
    },
  }
}

function randomKey(original: string): string {
  const dot = original.lastIndexOf('.')
  const ext = dot > 0 ? original.slice(dot).toLowerCase() : ''
  return crypto.randomUUID() + (/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '')
}
