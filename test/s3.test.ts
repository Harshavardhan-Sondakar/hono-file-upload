import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { fileUpload } from '../src'
import { s3Storage } from '../src/s3'
import { bigFileStream, file, form, rawRequest } from './helpers'

const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } })
const s3 = mockClient(client)

beforeEach(() => {
  s3.reset()
  s3.on(PutObjectCommand).resolves({ ETag: '"etag-1"' })
  s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-1' })
  s3.on(UploadPartCommand).callsFake((input) => ({ ETag: `"part-${input.PartNumber}"` }))
  s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"etag-multi"', Location: 'https://bucket.s3/key' })
  s3.on(AbortMultipartUploadCommand).resolves({})
  s3.on(DeleteObjectCommand).resolves({})
})

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  return new TextDecoder().decode(body as Uint8Array)
}

describe('s3Storage', () => {
  it('uploads a small file with PutObject', async () => {
    const app = new Hono()
    app.post(
      '/',
      fileUpload({ storage: s3Storage({ client, bucket: 'my-bucket', params: { CacheControl: 'max-age=60' } }) }),
      (c) => c.json(c.var.upload.files),
    )
    const res = await app.request('/', form([['avatar', file('hello s3', 'me.png', 'image/png')]]))
    const [saved] = await res.json()
    expect(saved).toMatchObject({
      bucket: 'my-bucket',
      etag: '"etag-1"',
      fieldName: 'avatar',
      filename: 'me.png',
      size: 8,
    })
    expect(saved.key).toMatch(/^[0-9a-f-]{36}\.png$/)

    const put = s3.commandCalls(PutObjectCommand)[0].args[0].input
    expect(put).toMatchObject({
      Bucket: 'my-bucket',
      Key: saved.key,
      ContentType: 'image/png',
      CacheControl: 'max-age=60',
    })
    expect(bodyText(put.Body)).toBe('hello s3')
  })

  it('uses a custom key', async () => {
    const app = new Hono()
    const storage = s3Storage({ client, bucket: 'b', key: (f) => `avatars/${f.fieldName}/${f.filename}` })
    app.post('/', fileUpload({ storage }), (c) => c.json(c.var.upload.files))
    const [saved] = await (await app.request('/', form([['avatar', file('x', 'me.png')]]))).json()
    expect(saved.key).toBe('avatars/avatar/me.png')
  })

  it('uploads a large file in parts', async () => {
    const size = 12 * 1024 * 1024
    const app = new Hono()
    app.post('/', fileUpload({ storage: s3Storage({ client, bucket: 'b' }), limits: { fileSize: size } }), (c) =>
      c.json(c.var.upload.files),
    )
    const [saved] = await (await app.request('/', rawRequest(bigFileStream(size)))).json()
    expect(saved).toMatchObject({ size, etag: '"etag-multi"', location: 'https://bucket.s3/key' })
    const parts = s3.commandCalls(UploadPartCommand)
    expect(parts.length).toBe(3)
    const uploaded = parts.reduce((n, p) => n + (p.args[0].input.Body as Uint8Array).byteLength, 0)
    expect(uploaded).toBe(size)
  })

  it('aborts the upload when the file is too large', async () => {
    const app = new Hono()
    app.post(
      '/',
      fileUpload({ storage: s3Storage({ client, bucket: 'b' }), limits: { fileSize: 6 * 1024 * 1024 } }),
      (c) => c.text('ok'),
    )
    const res = await app.request('/', rawRequest(bigFileStream(20 * 1024 * 1024)))
    expect(res.status).toBe(413)
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0)
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0)
    // parts that were already sent must not be left behind in the bucket
    expect(s3.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1)
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
  })

  it('deletes uploaded objects when the request fails', async () => {
    const app = new Hono()
    app.post('/', fileUpload({ storage: s3Storage({ client, bucket: 'b' }), limits: { files: 1 } }), (c) =>
      c.text('ok'),
    )
    const res = await app.request(
      '/',
      form([
        ['f', file('1', 'a.txt')],
        ['f', file('2', 'b.txt')],
      ]),
    )
    expect(res.status).toBe(413)
    const key = s3.commandCalls(PutObjectCommand)[0].args[0].input.Key
    expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input)).toEqual([{ Bucket: 'b', Key: key }])
  })

  it('reports S3 failures as STORAGE_ERROR', async () => {
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'))
    const app = new Hono()
    app.post('/', fileUpload({ storage: s3Storage({ client, bucket: 'b' }) }), (c) => c.text('ok'))
    const res = await app.request('/', form([['f', file('1', 'a.txt')]]))
    expect(res.status).toBe(500)
  })
})
