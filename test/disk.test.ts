import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileUpload } from '../src'
import { diskStorage } from '../src/disk'
import { bigFileStream, file, form, rawRequest } from './helpers'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hfu-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('diskStorage', () => {
  it('writes files with a random name and keeps a safe extension', async () => {
    const app = new Hono()
    app.post('/', fileUpload({ storage: diskStorage({ directory: dir }) }), (c) => c.json(c.var.upload.files))
    const res = await app.request(
      '/',
      form([
        ['f', file('hello disk', 'Report.PDF')],
        ['g', file('x', 'weird.ext;rm -rf')],
      ]),
    )
    const files = await res.json()
    expect(files[0].savedAs).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(files[1].savedAs).toMatch(/^[0-9a-f-]{36}$/)
    expect(files[0].path).toBe(join(dir, files[0].savedAs))
    expect(files[0]).toMatchObject({ fieldName: 'f', filename: 'Report.PDF', size: 10 })
    expect(await readFile(files[0].path, 'utf8')).toBe('hello disk')
  })

  it('creates the directory if needed', async () => {
    const nested = join(dir, 'a', 'b')
    const app = new Hono()
    app.post('/', fileUpload({ storage: diskStorage({ directory: nested }) }), (c) => c.json(c.var.upload.files))
    const res = await app.request('/', form([['f', file('x', 'a.txt')]]))
    expect(res.status).toBe(200)
    expect(await readdir(nested)).toHaveLength(1)
  })

  it('uses a custom filename', async () => {
    const app = new Hono()
    const storage = diskStorage({ directory: dir, filename: (f) => `${f.fieldName}-custom.txt` })
    app.post('/', fileUpload({ storage }), (c) => c.json(c.var.upload.files))
    await app.request('/', form([['avatar', file('x', 'a.txt')]]))
    expect(await readdir(dir)).toEqual(['avatar-custom.txt'])
  })

  it('refuses a custom filename that leaves the directory', async () => {
    const app = new Hono()
    const storage = diskStorage({ directory: join(dir, 'up'), filename: (f) => f.filename })
    app.post('/', fileUpload({ storage }), (c) => c.text('ok'))
    const res = await app.request('/', form([['f', file('x', '../escape.txt')]]))
    expect(res.status).toBe(500)
    expect(await readdir(dir)).toEqual(['up'])
  })

  it('does not overwrite an existing file', async () => {
    const app = new Hono()
    const storage = diskStorage({ directory: dir, filename: () => 'same.txt' })
    app.post('/', fileUpload({ storage }), (c) => c.text('ok'))
    expect((await app.request('/', form([['f', file('first', 'a.txt')]]))).status).toBe(200)
    expect((await app.request('/', form([['f', file('second', 'b.txt')]]))).status).toBe(500)
    expect(await readFile(join(dir, 'same.txt'), 'utf8')).toBe('first')
  })

  it('deletes the partial file when a file is too large', async () => {
    const app = new Hono()
    app.post('/', fileUpload({ storage: diskStorage({ directory: dir }), limits: { fileSize: 1024 * 1024 } }), (c) =>
      c.text('ok'),
    )
    const res = await app.request('/', rawRequest(bigFileStream(3 * 1024 * 1024, 64 * 1024)))
    expect(res.status).toBe(413)
    expect(await readdir(dir)).toEqual([])
  })

  it('deletes earlier files when the request fails', async () => {
    const app = new Hono()
    app.post('/', fileUpload({ storage: diskStorage({ directory: dir }), limits: { files: 2 } }), (c) => c.text('ok'))
    const res = await app.request(
      '/',
      form([
        ['f', file('1', 'a.txt')],
        ['f', file('2', 'b.txt')],
        ['f', file('3', 'c.txt')],
      ]),
    )
    expect(res.status).toBe(413)
    expect(await readdir(dir)).toEqual([])
  })

  it('streams a large file to disk without holding it in memory', async () => {
    const size = 200 * 1024 * 1024
    const app = new Hono()
    app.post('/', fileUpload({ storage: diskStorage({ directory: dir }), limits: { fileSize: size } }), (c) =>
      c.json(c.var.upload.files[0]),
    )
    globalThis.gc?.()
    const before = process.memoryUsage().rss
    let peak = before
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 5)
    const res = await app.request('/', rawRequest(bigFileStream(size)))
    clearInterval(timer)
    const saved = await res.json()
    expect(saved.size).toBe(size)
    // the file is 200 MiB, memory growth should stay far below that
    expect(peak - before).toBeLessThan(100 * 1024 * 1024)
  }, 60_000)
})
