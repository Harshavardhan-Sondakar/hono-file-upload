import { S3Client } from '@aws-sdk/client-s3'
import { Hono } from 'hono'
import { describe, expectTypeOf, it } from 'vitest'
import { fileUpload, memoryStorage, type Storage, type UploadResult } from '../src'
import { diskStorage } from '../src/disk'
import { s3Storage } from '../src/s3'

describe('types', () => {
  it('memory storage gives a File by default', () => {
    new Hono().post('/', fileUpload(), (c) => {
      const f = c.var.upload.file('a')
      expectTypeOf(f).toEqualTypeOf<
        { fieldName: string; filename: string; type: string; size: number; file: File } | undefined
      >()
      expectTypeOf(c.var.upload.fields).toEqualTypeOf<Record<string, string | string[]>>()
      return c.text('ok')
    })
    new Hono().post('/', fileUpload({ storage: memoryStorage() }), (c) => {
      expectTypeOf(c.var.upload.files[0].file).toEqualTypeOf<File>()
      return c.text('ok')
    })
  })

  it('disk storage gives a path', () => {
    new Hono().post('/', fileUpload({ storage: diskStorage({ directory: '/tmp' }) }), (c) => {
      const f = c.var.upload.files[0]
      expectTypeOf(f.path).toEqualTypeOf<string>()
      expectTypeOf(f.savedAs).toEqualTypeOf<string>()
      // @ts-expect-error disk files have no File object
      f.file
      return c.text('ok')
    })
  })

  it('s3 storage gives a key and bucket', () => {
    const client = new S3Client({})
    new Hono().post('/', fileUpload({ storage: s3Storage({ client, bucket: 'b' }) }), (c) => {
      const f = c.var.upload.files[0]
      expectTypeOf(f.key).toEqualTypeOf<string>()
      expectTypeOf(f.bucket).toEqualTypeOf<string>()
      expectTypeOf(f.location).toEqualTypeOf<string | undefined>()
      return c.text('ok')
    })
  })

  it('custom storage results are typed', () => {
    const storage: Storage<{ url: string }> = { save: async () => ({ url: '' }) }
    new Hono().post('/', fileUpload({ storage }), (c) => {
      expectTypeOf(c.var.upload).toEqualTypeOf<UploadResult<typeof storage>>()
      expectTypeOf(c.var.upload.files[0].url).toEqualTypeOf<string>()
      return c.text('ok')
    })
  })
})
