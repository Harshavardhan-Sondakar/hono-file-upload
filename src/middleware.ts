import type { Context, MiddlewareHandler } from 'hono'
import { parseMultipart } from 'multitars'
import { parseDisposition } from './content-disposition'
import { UploadError } from './errors'
import { type MemoryStorage, memoryStorage } from './storage/memory'
import type { FileInfo, IncomingFile, Storage, UploadedFile, UploadOptions, UploadResult } from './types'

const MiB = 1024 * 1024

const defaultLimits = {
  fileSize: 10 * MiB,
  files: 10,
  fields: 100,
  fieldSize: MiB,
}

export type UploadEnv<S extends Storage> = {
  Variables: {
    upload: UploadResult<S>
  }
}

/**
 * Parses a `multipart/form-data` request and saves the files as they stream in.
 * The result is available as `c.var.upload` in the next handlers.
 *
 * ```ts
 * app.post('/avatar', fileUpload({ limits: { fileSize: 2 * 1024 * 1024 } }), async (c) => {
 *   const avatar = c.var.upload.file('avatar')
 *   return c.json({ name: avatar?.filename, size: avatar?.size })
 * })
 * ```
 */
export function fileUpload(options?: UploadOptions<MemoryStorage>): MiddlewareHandler<UploadEnv<MemoryStorage>>
export function fileUpload<S extends Storage>(
  options: UploadOptions<S> & { storage: S },
): MiddlewareHandler<UploadEnv<S>>
export function fileUpload(options: UploadOptions<Storage> = {}): MiddlewareHandler<UploadEnv<Storage>> {
  const storage = options.storage ?? memoryStorage()
  const limits = { ...defaultLimits, ...options.limits }
  const fieldCounts = Array.isArray(options.fileFields)
    ? Object.fromEntries(options.fileFields.map((name) => [name, Number.POSITIVE_INFINITY]))
    : options.fileFields
  const allowedTypes = options.allowedTypes?.map((t) => t.toLowerCase())

  return async (c, next) => {
    const contentType = c.req.header('content-type') ?? ''
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
      throw new UploadError('NOT_MULTIPART', 'Expected a multipart/form-data request')
    }
    const body = c.req.raw.body
    if (!body) {
      throw new UploadError('MALFORMED_BODY', 'Request body is empty')
    }
    if (c.req.raw.bodyUsed) {
      throw new Error('fileUpload(): the request body was already read by an earlier middleware')
    }

    const files: (FileInfo & object)[] = []
    // field names come from the client, so use objects without a prototype
    // (a field called "__proto__" or "constructor" is then just a normal key)
    const fields: Record<string, string | string[]> = Object.create(null)
    const perField: Record<string, number> = Object.create(null)
    let fieldCount = 0

    try {
      for await (const part of parseMultipart(body, { contentType })) {
        const { name, filename } = parseDisposition(part.headers['content-disposition'])
        if (name === undefined) {
          throw new UploadError('MALFORMED_BODY', 'A form part is missing its field name')
        }

        // text field
        if (filename === undefined) {
          if (++fieldCount > limits.fields) {
            throw new UploadError('TOO_MANY_FIELDS', `Too many fields (max ${limits.fields})`, { field: name })
          }
          const value = await readText(part.stream(), limits.fieldSize, name)
          const existing = fields[name]
          if (existing === undefined) fields[name] = value
          else if (Array.isArray(existing)) existing.push(value)
          else fields[name] = [existing, value]
          continue
        }

        // file field
        let stream: ReadableStream<Uint8Array> = part.stream()
        if (filename === '') {
          // an empty file input in a browser form sends an empty part, skip it
          const peeked = await peek(stream)
          if (!peeked) continue
          stream = peeked
        }

        if (fieldCounts) {
          const max = Object.hasOwn(fieldCounts, name) ? fieldCounts[name] : undefined
          if (max === undefined) {
            throw new UploadError('UNEXPECTED_FILE', `Unexpected file field "${name}"`, { field: name })
          }
          perField[name] = (perField[name] ?? 0) + 1
          if (perField[name] > max) {
            throw new UploadError('TOO_MANY_FILES', `Too many files for field "${name}" (max ${max})`, { field: name })
          }
        }
        if (files.length >= limits.files) {
          throw new UploadError('TOO_MANY_FILES', `Too many files (max ${limits.files})`, { field: name })
        }

        const type = mediaType(part.headers['content-type'])
        if (allowedTypes && !isAllowed(type, allowedTypes)) {
          throw new UploadError('FILE_TYPE_NOT_ALLOWED', `File type "${type}" is not allowed`, { field: name })
        }
        if (options.fileFilter && !(await options.fileFilter({ fieldName: name, filename, type }, c as Context))) {
          throw new UploadError('FILE_REJECTED', `File "${filename}" was rejected`, { field: name })
        }

        const counter = sizeCounter(limits.fileSize, name)
        const incoming: IncomingFile = {
          fieldName: name,
          filename,
          type,
          stream: stream.pipeThrough(counter.transform),
        }
        let saved: object
        try {
          saved = await storage.save(incoming)
        } catch (err) {
          // the storage may wrap our error, so check the counter first
          if (counter.error) throw counter.error
          if (err instanceof UploadError) throw err
          throw new UploadError('STORAGE_ERROR', 'Could not save the uploaded file', { field: name, cause: err })
        }
        if (counter.error) throw counter.error

        files.push({ ...saved, fieldName: name, filename, type, size: counter.size })
      }
    } catch (err) {
      await cleanup(storage, files)
      body.cancel().catch(() => {})
      if (err instanceof UploadError) throw err
      throw new UploadError('MALFORMED_BODY', 'Could not parse the multipart body', { cause: err })
    }

    const result: UploadResult<Storage> = {
      files: files as UploadedFile<Storage>[],
      fields,
      file: (fieldName) => result.files.find((f) => f.fieldName === fieldName),
      filesFor: (fieldName) => result.files.filter((f) => f.fieldName === fieldName),
    }
    c.set('upload', result)
    await next()
  }
}

function sizeCounter(max: number, field: string) {
  const state = {
    size: 0,
    error: undefined as UploadError | undefined,
    transform: new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        state.size += chunk.byteLength
        if (state.size > max) {
          state.error = new UploadError('FILE_TOO_LARGE', `File is too large (max ${max} bytes)`, { field })
          controller.error(state.error)
          return
        }
        controller.enqueue(chunk)
      },
    }),
  }
  return state
}

async function readText(stream: ReadableStream<Uint8Array>, max: number, field: string): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let size = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new UploadError('FIELD_TOO_LARGE', `Field "${field}" is too large (max ${max} bytes)`, { field })
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

// returns null for an empty stream, otherwise a stream with the same content
async function peek(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | null> {
  const reader = stream.getReader()
  let first = await reader.read()
  while (!first.done && first.value.byteLength === 0) first = await reader.read()
  if (first.done) return null
  let sentFirst = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true
        controller.enqueue(first.value as Uint8Array)
        return
      }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function mediaType(header: string | undefined): string {
  const type = header?.split(';')[0].trim().toLowerCase()
  return type || 'application/octet-stream'
}

function isAllowed(type: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === '*/*' || pattern === type) return true
    if (pattern.endsWith('/*') && type.startsWith(pattern.slice(0, -1))) return true
  }
  return false
}

async function cleanup(storage: Storage, files: object[]) {
  if (!storage.remove) return
  await Promise.all(files.map((f) => storage.remove?.(f as never).catch(() => {})))
}
