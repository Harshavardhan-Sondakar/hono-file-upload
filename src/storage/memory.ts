import type { IncomingFile, Storage } from '../types'

export interface MemoryStorageResult {
  /** The uploaded file, ready to use like any `File` (`.arrayBuffer()`, `.text()`, ...). */
  file: File
}

export type MemoryStorage = Storage<MemoryStorageResult>

/**
 * Keeps each file in memory as a standard `File`.
 * Good for small files or when you pass them on yourself
 * (for example to an R2 bucket). Keep `limits.fileSize` low with this one.
 */
export function memoryStorage(): MemoryStorage {
  return {
    async save({ stream, filename, type }: IncomingFile) {
      const chunks: Uint8Array[] = []
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      return { file: new File(chunks as BlobPart[], filename, { type }) }
    },
  }
}
