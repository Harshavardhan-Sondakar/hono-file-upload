import type { Context } from 'hono'

/** A file as it comes in, before it is saved. */
export interface IncomingFile {
  /** Name of the form field, e.g. `avatar`. */
  fieldName: string
  /**
   * Filename sent by the client. Don't trust it and never use it as a path
   * on disk without cleaning it first.
   */
  filename: string
  /** Content type sent by the client, e.g. `image/png`. */
  type: string
  /** The file contents. Read it once, as a stream. */
  stream: ReadableStream<Uint8Array>
}

/** Where files go. Implement this to save files anywhere you like. */
export interface Storage<T extends object = object> {
  /**
   * Save the file and return whatever you need to find it later
   * (a path, a key, a `File`...). This is merged into the uploaded file info.
   *
   * If the stream errors (for example the file is too large), clean up
   * anything you already wrote and let the error through.
   */
  save(file: IncomingFile): Promise<T>
  /**
   * Delete a file that was already saved. Called when the request fails
   * after this file was stored, so you don't keep half of an upload around.
   */
  remove?(saved: T & FileInfo): Promise<void>
}

/** Info about every uploaded file, no matter which storage you use. */
export interface FileInfo {
  fieldName: string
  filename: string
  type: string
  /** Size in bytes. */
  size: number
}

// flattens `A & B` into one object type so editors show it nicely
type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type UploadedFile<S extends Storage> = Simplify<FileInfo & StorageResult<S>>

export type StorageResult<S> = S extends Storage<infer T> ? T : never

export interface UploadResult<S extends Storage> {
  /** All uploaded files, in the order they were sent. */
  files: UploadedFile<S>[]
  /** Text fields. A field sent more than once becomes an array. */
  fields: Record<string, string | string[]>
  /** First uploaded file for a field, or `undefined`. */
  file(fieldName: string): UploadedFile<S> | undefined
  /** All uploaded files for a field. */
  filesFor(fieldName: string): UploadedFile<S>[]
}

export interface UploadLimits {
  /** Max size of one file in bytes. Default 10 MiB. */
  fileSize?: number
  /** Max number of files. Default 10. */
  files?: number
  /** Max number of text fields. Default 100. */
  fields?: number
  /** Max size of one text field in bytes. Default 1 MiB. */
  fieldSize?: number
}

export interface UploadOptions<S extends Storage> {
  /** Where to save files. Default is `memoryStorage()`. */
  storage?: S
  limits?: UploadLimits
  /**
   * Allowed content types, e.g. `['image/png', 'image/*', 'application/pdf']`.
   * This checks the type the client sent, so treat it as a first filter only.
   */
  allowedTypes?: string[]
  /**
   * Allowed file field names. Files sent in any other field are rejected.
   * You can also set a max count per field: `{ avatar: 1, photos: 5 }`.
   */
  fileFields?: string[] | Record<string, number>
  /**
   * Your own check, run before a file is saved. Return `false` to reject it.
   */
  fileFilter?: (file: Omit<IncomingFile, 'stream'>, c: Context) => boolean | Promise<boolean>
}
