# hono-file-upload

File upload middleware for [Hono](https://hono.dev). Think `multer`, but for Hono and every runtime it supports.

- **Streams files** to disk or S3 as they arrive, so a 1 GB upload doesn't need 1 GB of memory
- **Limits** for file size, number of files, number of fields and field size
- **Type checks** with wildcards like `image/*`
- **Cleans up** after itself: if a request fails halfway, files that were already saved get deleted
- **Typed**: `c.var.upload` knows what your storage returns
- Works on **Node.js, Bun, Deno and Cloudflare Workers**

```sh
npm install hono-file-upload
```

## Why

Hono's `c.req.parseBody()` reads the whole request into memory before you can look at it. That's fine for small forms, but for large files it uses a lot of memory, and you can't stop a bad upload early.

This middleware reads the request as a stream. Each file goes straight to your storage, and limits are checked while the data is coming in, so an oversized file is stopped at the limit, not after it's fully uploaded.

## Quick start

```ts
import { Hono } from 'hono'
import { fileUpload } from 'hono-file-upload'

const app = new Hono()

app.post(
  '/avatar',
  fileUpload({
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    allowedTypes: ['image/png', 'image/jpeg'],
  }),
  async (c) => {
    const avatar = c.var.upload.file('avatar')
    if (!avatar) return c.text('No file', 400)

    // memory storage (the default) gives you a normal File
    const bytes = await avatar.file.arrayBuffer()

    return c.json({ name: avatar.filename, size: avatar.size, user: c.var.upload.fields.user })
  },
)
```

`c.var.upload` has:

| | |
|---|---|
| `files` | All uploaded files, in the order they were sent |
| `fields` | Text fields. A field sent more than once becomes an array |
| `file(name)` | The first file for a field, or `undefined` |
| `filesFor(name)` | All files for a field |

Every file has `fieldName`, `filename`, `type` and `size`, plus whatever the storage adds.

## Storage

### Memory (default)

Each file is kept in memory as a `File`. Good for small files, or when you pass the file on yourself. Keep `limits.fileSize` low when using it.

```ts
import { fileUpload, memoryStorage } from 'hono-file-upload'

app.post('/upload', fileUpload({ storage: memoryStorage() }), async (c) => {
  const { file } = c.var.upload.files[0] // a File
})
```

### Disk (Node.js, Bun, Deno)

```ts
import { diskStorage } from 'hono-file-upload/disk'

app.post(
  '/upload',
  fileUpload({ storage: diskStorage({ directory: './uploads' }), limits: { fileSize: 500 * 1024 * 1024 } }),
  (c) => {
    const { path, savedAs } = c.var.upload.files[0]
    return c.json({ savedAs })
  },
)
```

Files get a random name plus the original extension, like `3f2a9c1e-....png`. The name the client sent is never used as a path. You can choose your own name with `filename: (file) => string`, as long as it stays inside `directory`. Existing files are never overwritten.

### S3, Cloudflare R2, MinIO and other S3-compatible storage

```sh
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

```ts
import { S3Client } from '@aws-sdk/client-s3'
import { s3Storage } from 'hono-file-upload/s3'

const client = new S3Client({ region: 'us-east-1' })

app.post(
  '/upload',
  fileUpload({
    storage: s3Storage({
      client,
      bucket: 'my-bucket',
      key: (file) => `uploads/${crypto.randomUUID()}`, // optional
      params: { CacheControl: 'max-age=31536000' }, // optional, any PutObject params
    }),
  }),
  (c) => c.json(c.var.upload.files.map((f) => f.key)),
)
```

Large files are uploaded in 5 MB parts while they stream in. If a file goes over the limit, the multipart upload is aborted so no parts are left behind.

For **Cloudflare R2**, point the client at R2's S3 endpoint:

```ts
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})
```

### Your own storage

A storage is an object with `save()` and, optionally, `remove()`:

```ts
import type { Storage } from 'hono-file-upload'

const myStorage: Storage<{ url: string }> = {
  async save(file) {
    // file.stream is a ReadableStream with the file contents
    const url = await sendSomewhere(file.stream, file.filename, file.type)
    return { url }
  },
  async remove(saved) {
    // called if the request fails after this file was saved
    await deleteFromSomewhere(saved.url)
  },
}

app.post('/upload', fileUpload({ storage: myStorage }), (c) => {
  c.var.upload.files[0].url // typed as string
})
```

If the stream errors (for example the file is too large), clean up anything you wrote and let the error through.

## Options

```ts
fileUpload({
  storage, // default: memoryStorage()
  limits: {
    fileSize: 10 * 1024 * 1024, // bytes per file, default 10 MB
    files: 10, // max number of files, default 10
    fields: 100, // max number of text fields, default 100
    fieldSize: 1024 * 1024, // bytes per text field, default 1 MB
  },
  allowedTypes: ['image/*', 'application/pdf'], // default: any type
  fileFields: ['avatar', 'photos'], // only accept files in these fields
  // or with a max count per field:
  // fileFields: { avatar: 1, photos: 5 },
  fileFilter: (file, c) => !file.filename.endsWith('.exe'), // return false to reject
})
```

`allowedTypes` checks the type the client sent, which can be faked. Use it to catch mistakes, and check the actual file contents yourself if it matters.

Empty file inputs (a form submitted without picking a file) are skipped.

## Errors

When an upload is rejected, the middleware throws an `UploadError`. It extends Hono's `HTTPException`, so the client gets the right status code even if you do nothing:

| `code` | Status | When |
|---|---|---|
| `NOT_MULTIPART` | 415 | The request isn't `multipart/form-data` |
| `MALFORMED_BODY` | 400 | The body can't be parsed |
| `FILE_TOO_LARGE` | 413 | A file is over `limits.fileSize` |
| `TOO_MANY_FILES` | 413 | Over `limits.files`, or over a `fileFields` count |
| `TOO_MANY_FIELDS` | 413 | Over `limits.fields` |
| `FIELD_TOO_LARGE` | 413 | A text field is over `limits.fieldSize` |
| `FILE_TYPE_NOT_ALLOWED` | 415 | The type isn't in `allowedTypes` |
| `UNEXPECTED_FILE` | 400 | A file came in a field not listed in `fileFields` |
| `FILE_REJECTED` | 400 | `fileFilter` returned `false` |
| `STORAGE_ERROR` | 500 | The storage failed (the original error is in `cause`) |

To send your own error response:

```ts
import { UploadError } from 'hono-file-upload'

app.onError((err, c) => {
  if (err instanceof UploadError) {
    return c.json({ error: err.code, field: err.field, message: err.message }, err.status)
  }
  return c.text('Internal error', 500)
})
```

## Good to know

- The middleware reads the request body, so don't call `c.req.parseBody()` or `c.req.formData()` in the same route.
- You can still use Hono's `bodyLimit` middleware before this one to cap the whole request size.
- On Cloudflare Workers, use memory storage for small files or S3/R2 storage for big ones. Workers have no disk.

## License

MIT
