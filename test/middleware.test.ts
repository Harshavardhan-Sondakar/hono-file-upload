import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { fileUpload, type MemoryStorage, type Storage, UploadError, type UploadOptions } from '../src'
import { file, form, rawMultipart, rawRequest } from './helpers'

function appWith(options?: UploadOptions<MemoryStorage>) {
  const app = new Hono()
  app.post('/', fileUpload(options), async (c) => {
    const { files, fields } = c.var.upload
    return c.json({
      fields,
      files: await Promise.all(
        files.map(async ({ file, ...info }) => ({
          ...info,
          content: await file.text(),
          fileType: file.type,
          fileName: file.name,
        })),
      ),
    })
  })
  app.onError((err, c) => {
    if (err instanceof UploadError) return c.json({ code: err.code, field: err.field }, err.status)
    return c.json({ error: String(err) }, 500)
  })
  return app
}

describe('parsing', () => {
  it('reads text fields and files', async () => {
    const res = await appWith().request(
      '/',
      form([
        ['title', 'Hello'],
        ['avatar', file('abc', 'me.png', 'image/png')],
      ]),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fields: { title: 'Hello' },
      files: [
        {
          fieldName: 'avatar',
          filename: 'me.png',
          type: 'image/png',
          size: 3,
          content: 'abc',
          fileType: 'image/png',
          fileName: 'me.png',
        },
      ],
    })
  })

  it('turns repeated fields into arrays', async () => {
    const res = await appWith().request(
      '/',
      form([
        ['tag', 'a'],
        ['tag', 'b'],
        ['tag', 'c'],
        ['one', 'x'],
      ]),
    )
    expect((await res.json()).fields).toEqual({ tag: ['a', 'b', 'c'], one: 'x' })
  })

  it('keeps several files and their order', async () => {
    const res = await appWith().request(
      '/',
      form([
        ['photos', file('1', 'a.txt')],
        ['doc', file('22', 'b.txt')],
        ['photos', file('333', 'c.txt')],
      ]),
    )
    const body = await res.json()
    expect(body.files.map((f: { filename: string; size: number }) => [f.filename, f.size])).toEqual([
      ['a.txt', 1],
      ['b.txt', 2],
      ['c.txt', 3],
    ])
  })

  it('gives file() and filesFor() helpers', async () => {
    const app = new Hono()
    app.post('/', fileUpload(), (c) =>
      c.json({
        first: c.var.upload.file('photos')?.filename,
        all: c.var.upload.filesFor('photos').map((f) => f.filename),
        missing: c.var.upload.file('nope') ?? null,
      }),
    )
    const res = await app.request(
      '/',
      form([
        ['photos', file('1', 'a.txt')],
        ['photos', file('2', 'b.txt')],
      ]),
    )
    expect(await res.json()).toEqual({ first: 'a.txt', all: ['a.txt', 'b.txt'], missing: null })
  })

  it('decodes UTF-8 field values and filename*', async () => {
    const body = rawMultipart([
      { disposition: 'form-data; name="city"', body: 'Hubballi ಹುಬ್ಬಳ್ಳಿ' },
      {
        disposition: `form-data; name="doc"; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve%20%E2%9C%93.txt`,
        type: 'text/plain; charset=utf-8',
        body: 'ok',
      },
    ])
    const res = await appWith().request('/', rawRequest(body))
    const json = await res.json()
    expect(json.fields.city).toBe('Hubballi ಹುಬ್ಬಳ್ಳಿ')
    expect(json.files[0].filename).toBe('naïve ✓.txt')
    expect(json.files[0].type).toBe('text/plain')
  })

  it('handles quotes and semicolons inside filenames', async () => {
    const body = rawMultipart([{ disposition: 'form-data; name="f"; filename="a \\"b\\"; c.txt"', body: 'x' }])
    const json = await (await appWith().request('/', rawRequest(body))).json()
    expect(json.files[0].filename).toBe('a "b"; c.txt')
  })

  it('defaults the type to application/octet-stream', async () => {
    const body = rawMultipart([{ disposition: 'form-data; name="f"; filename="x.bin"', body: 'x' }])
    const json = await (await appWith().request('/', rawRequest(body))).json()
    expect(json.files[0].type).toBe('application/octet-stream')
  })

  it('skips an empty file input', async () => {
    const body = rawMultipart([
      { disposition: 'form-data; name="avatar"; filename=""', type: 'application/octet-stream', body: '' },
      { disposition: 'form-data; name="title"', body: 'x' },
    ])
    const json = await (await appWith().request('/', rawRequest(body))).json()
    expect(json).toEqual({ fields: { title: 'x' }, files: [] })
  })

  it('keeps a file with an empty filename when it has content', async () => {
    const body = rawMultipart([{ disposition: 'form-data; name="blob"; filename=""', body: 'data' }])
    const json = await (await appWith().request('/', rawRequest(body))).json()
    expect(json.files[0]).toMatchObject({ fieldName: 'blob', filename: '', size: 4, content: 'data' })
  })

  it('handles a zero-byte file with a name', async () => {
    const body = rawMultipart([{ disposition: 'form-data; name="f"; filename="empty.txt"', body: '' }])
    const json = await (await appWith().request('/', rawRequest(body))).json()
    expect(json.files[0]).toMatchObject({ filename: 'empty.txt', size: 0, content: '' })
  })
})

describe('request errors', () => {
  it('rejects non-multipart requests with 415', async () => {
    const res = await appWith().request('/', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'NOT_MULTIPART' })
  })

  it('rejects a multipart content type without a boundary', async () => {
    const res = await appWith().request('/', {
      method: 'POST',
      body: 'x',
      headers: { 'content-type': 'multipart/form-data' },
    })
    expect(res.status).toBe(415)
  })

  it('rejects a broken body with 400', async () => {
    const res = await appWith().request('/', rawRequest('this is not multipart at all'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MALFORMED_BODY')
  })

  it('rejects a part without a field name', async () => {
    const body = rawMultipart([{ disposition: 'form-data; filename="a.txt"', body: 'x' }])
    const res = await appWith().request('/', rawRequest(body))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MALFORMED_BODY')
  })

  it('returns a proper status without app.onError', async () => {
    const app = new Hono()
    app.post('/', fileUpload({ limits: { fileSize: 2 } }), (c) => c.text('ok'))
    const res = await app.request('/', form([['f', file('too big', 'a.txt')]]))
    expect(res.status).toBe(413)
    expect(await res.text()).toContain('too large')
  })
})

describe('limits', () => {
  it('rejects a file over fileSize with 413', async () => {
    const res = await appWith({ limits: { fileSize: 5 } }).request('/', form([['f', file('123456', 'a.txt')]]))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'FILE_TOO_LARGE', field: 'f' })
  })

  it('accepts a file exactly at fileSize', async () => {
    const res = await appWith({ limits: { fileSize: 5 } }).request('/', form([['f', file('12345', 'a.txt')]]))
    expect(res.status).toBe(200)
  })

  it('limits the number of files', async () => {
    const res = await appWith({ limits: { files: 2 } }).request(
      '/',
      form([
        ['f', file('1', 'a')],
        ['f', file('2', 'b')],
        ['f', file('3', 'c')],
      ]),
    )
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe('TOO_MANY_FILES')
  })

  it('limits the number of fields', async () => {
    const res = await appWith({ limits: { fields: 2 } }).request(
      '/',
      form([
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
      ]),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'TOO_MANY_FIELDS', field: 'c' })
  })

  it('limits the size of a field', async () => {
    const res = await appWith({ limits: { fieldSize: 3 } }).request('/', form([['note', 'abcd']]))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'FIELD_TOO_LARGE', field: 'note' })
  })

  it('uses a 10 MiB default file limit', async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.bin')
    const res = await appWith().request('/', form([['f', big]]))
    expect(res.status).toBe(413)
  })
})

describe('file checks', () => {
  it('allows only listed types, with wildcards', async () => {
    const app = appWith({ allowedTypes: ['image/*', 'application/pdf'] })
    expect((await app.request('/', form([['f', file('x', 'a.png', 'image/png')]]))).status).toBe(200)
    expect((await app.request('/', form([['f', file('x', 'a.pdf', 'application/pdf')]]))).status).toBe(200)
    const res = await app.request('/', form([['f', file('x', 'a.exe', 'application/x-msdownload')]]))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'FILE_TYPE_NOT_ALLOWED', field: 'f' })
  })

  it('matches types without case or parameters', async () => {
    const body = rawMultipart([
      { disposition: 'form-data; name="f"; filename="a.txt"', type: 'Text/Plain; charset=utf-8', body: 'x' },
    ])
    expect((await appWith({ allowedTypes: ['text/plain'] }).request('/', rawRequest(body))).status).toBe(200)
  })

  it('rejects files in unexpected fields', async () => {
    const res = await appWith({ fileFields: ['avatar'] }).request('/', form([['other', file('x', 'a.txt')]]))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'UNEXPECTED_FILE', field: 'other' })
  })

  it('does not apply fileFields to text fields', async () => {
    const res = await appWith({ fileFields: ['avatar'] }).request('/', form([['title', 'x']]))
    expect(res.status).toBe(200)
  })

  it('limits files per field', async () => {
    const app = appWith({ fileFields: { avatar: 1, photos: 2 } })
    const ok = await app.request(
      '/',
      form([
        ['avatar', file('1', 'a')],
        ['photos', file('2', 'b')],
        ['photos', file('3', 'c')],
      ]),
    )
    expect(ok.status).toBe(200)
    const res = await app.request(
      '/',
      form([
        ['avatar', file('1', 'a')],
        ['avatar', file('2', 'b')],
      ]),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'TOO_MANY_FILES', field: 'avatar' })
  })

  it('runs fileFilter with the file info and context', async () => {
    const fileFilter = vi.fn((f: { filename: string }, _c: unknown) => !f.filename.endsWith('.exe'))
    const app = appWith({ fileFilter })
    expect((await app.request('/', form([['f', file('x', 'ok.txt')]]))).status).toBe(200)
    const res = await app.request('/', form([['f', file('x', 'bad.exe')]]))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('FILE_REJECTED')
    expect(fileFilter.mock.calls[0][0]).toEqual({ fieldName: 'f', filename: 'ok.txt', type: 'text/plain' })
    expect(fileFilter.mock.calls[0][1]).toHaveProperty('req')
  })
})

describe('unsafe field names', () => {
  it('does not let built-in names get past fileFields', async () => {
    const app = appWith({ fileFields: ['avatar'] })
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await app.request('/', form([[name, file('x', 'a.txt')]]))
      expect(res.status, name).toBe(400)
      expect((await res.json()).code).toBe('UNEXPECTED_FILE')
    }
  })

  it('treats __proto__ and constructor as normal text fields', async () => {
    const app = new Hono()
    app.post('/', fileUpload(), (c) => {
      const { fields } = c.var.upload
      return c.json({
        proto: fields.__proto__,
        ctor: fields.constructor,
        keys: Object.keys(fields),
        polluted: ({} as Record<string, unknown>).polluted ?? null,
      })
    })
    const res = await app.request(
      '/',
      form([
        ['__proto__', 'a'],
        ['__proto__', 'b'],
        ['constructor', 'c'],
        ['polluted', 'no'],
      ]),
    )
    expect(await res.json()).toEqual({
      proto: ['a', 'b'],
      ctor: 'c',
      keys: ['__proto__', 'constructor', 'polluted'],
      polluted: null,
    })
  })
})

describe('custom storage', () => {
  function trackingStorage(failOn?: string) {
    const saved: string[] = []
    const removed: string[] = []
    const storage: Storage<{ id: string }> = {
      async save(f) {
        const text = await new Response(f.stream).text()
        if (f.filename === failOn) throw new Error('disk full')
        saved.push(f.filename)
        return { id: `${f.filename}:${text}` }
      },
      async remove(s) {
        removed.push(s.id)
      },
    }
    return { storage, saved, removed }
  }

  it('merges the storage result into the file info', async () => {
    const { storage } = trackingStorage()
    const app = new Hono()
    app.post('/', fileUpload({ storage }), (c) => c.json(c.var.upload.files))
    const res = await app.request('/', form([['f', file('hey', 'a.txt')]]))
    expect(await res.json()).toEqual([
      { id: 'a.txt:hey', fieldName: 'f', filename: 'a.txt', type: 'text/plain', size: 3 },
    ])
  })

  it('removes saved files when a later file fails', async () => {
    const { storage, removed } = trackingStorage()
    const app = new Hono()
    app.post('/', fileUpload({ storage, limits: { fileSize: 3 } }), (c) => c.text('ok'))
    const res = await app.request(
      '/',
      form([
        ['f', file('1', 'a.txt')],
        ['f', file('22', 'b.txt')],
        ['f', file('4444', 'c.txt')],
      ]),
    )
    expect(res.status).toBe(413)
    expect(removed).toEqual(['a.txt:1', 'b.txt:22'])
  })

  it('removes saved files when a later field is invalid', async () => {
    const { storage, removed } = trackingStorage()
    const app = new Hono()
    app.post('/', fileUpload({ storage, limits: { fields: 0 } }), (c) => c.text('ok'))
    const res = await app.request(
      '/',
      form([
        ['f', file('1', 'a.txt')],
        ['title', 'x'],
      ]),
    )
    expect(res.status).toBe(413)
    expect(removed).toEqual(['a.txt:1'])
  })

  it('wraps storage failures as STORAGE_ERROR with the cause', async () => {
    const { storage, removed } = trackingStorage('b.txt')
    const app = new Hono()
    let caught: unknown
    app.post('/', fileUpload({ storage }), (c) => c.text('ok'))
    app.onError((err, c) => {
      caught = err
      return c.text('err', 500)
    })
    await app.request(
      '/',
      form([
        ['f', file('1', 'a.txt')],
        ['f', file('2', 'b.txt')],
      ]),
    )
    expect(caught).toBeInstanceOf(UploadError)
    expect((caught as UploadError).code).toBe('STORAGE_ERROR')
    expect(((caught as UploadError).cause as Error).message).toBe('disk full')
    expect(removed).toEqual(['a.txt:1'])
  })

  it('reports FILE_TOO_LARGE even if the storage wraps the stream error', async () => {
    const storage: Storage<object> = {
      async save(f) {
        try {
          await new Response(f.stream).arrayBuffer()
        } catch (e) {
          throw new Error('wrapped', { cause: e })
        }
        return {}
      },
    }
    const app = new Hono()
    app.post('/', fileUpload({ storage, limits: { fileSize: 2 } }), (c) => c.text('ok'))
    const res = await app.request('/', form([['f', file('12345', 'a.txt')]]))
    expect(res.status).toBe(413)
  })

  it('does not run the handler when the upload fails', async () => {
    const handler = vi.fn((c) => c.text('ok'))
    const app = new Hono()
    app.post('/', fileUpload({ limits: { files: 0 } }), handler)
    await app.request('/', form([['f', file('1', 'a.txt')]]))
    expect(handler).not.toHaveBeenCalled()
  })
})
