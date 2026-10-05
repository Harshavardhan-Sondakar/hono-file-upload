import { randomUUID } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { IncomingFile, Storage } from '../types'

export interface DiskStorageOptions {
  /** Folder to save files in. Created if it doesn't exist. */
  directory: string
  /**
   * Name of the saved file. By default it's a random UUID plus the original
   * extension (if it looks safe), e.g. `3f2a...c1.png`.
   * The name must stay inside `directory`.
   */
  filename?: (file: Omit<IncomingFile, 'stream'>) => string | Promise<string>
}

export interface DiskStorageResult {
  /** Full path of the saved file. */
  path: string
  /** Name of the saved file inside `directory`. */
  savedAs: string
}

export type DiskStorage = Storage<DiskStorageResult>

/**
 * Streams files straight to disk, so large uploads don't fill up memory.
 * Works on Node.js, Bun and Deno.
 */
export function diskStorage(options: DiskStorageOptions): DiskStorage {
  const directory = resolve(options.directory)
  let ready: Promise<unknown> | undefined

  return {
    async save(file) {
      ready ??= mkdir(directory, { recursive: true })
      await ready

      const { stream, ...info } = file
      const savedAs = options.filename ? await options.filename(info) : randomName(info.filename)
      const path = resolve(directory, savedAs)
      if (!path.startsWith(directory + sep)) {
        throw new Error(`diskStorage: filename "${savedAs}" points outside of the upload directory`)
      }

      // 'wx' fails if the file exists, so we never overwrite or delete someone else's file
      const handle = await open(path, 'wx')
      try {
        // the write stream takes over the handle and closes it when done
        await pipeline(Readable.fromWeb(stream as NodeReadableStream<Uint8Array>), handle.createWriteStream())
      } catch (err) {
        await handle.close().catch(() => {})
        await unlink(path).catch(() => {})
        throw err
      }
      return { path, savedAs }
    },

    async remove(saved) {
      await unlink(saved.path).catch(() => {})
    },
  }
}

function randomName(original: string): string {
  const ext = extname(original).toLowerCase()
  // keep short, plain extensions only (".png", ".tar", ".webm")
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
  return randomUUID() + safeExt
}
