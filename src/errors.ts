import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type UploadErrorCode =
  | 'NOT_MULTIPART'
  | 'MALFORMED_BODY'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'TOO_MANY_FIELDS'
  | 'FIELD_TOO_LARGE'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'UNEXPECTED_FILE'
  | 'FILE_REJECTED'
  | 'STORAGE_ERROR'

const statusByCode: Record<UploadErrorCode, ContentfulStatusCode> = {
  NOT_MULTIPART: 415,
  MALFORMED_BODY: 400,
  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  TOO_MANY_FIELDS: 413,
  FIELD_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 415,
  UNEXPECTED_FILE: 400,
  FILE_REJECTED: 400,
  STORAGE_ERROR: 500,
}

/**
 * Thrown when an upload is rejected. It extends Hono's `HTTPException`,
 * so if you don't handle it the client gets the right status code.
 *
 * Use `err.code` in `app.onError` if you want your own error response.
 */
export class UploadError extends HTTPException {
  readonly code: UploadErrorCode
  /** The form field the error is about, if there is one. */
  readonly field?: string

  constructor(code: UploadErrorCode, message: string, options?: { field?: string; cause?: unknown }) {
    super(statusByCode[code], { message, cause: options?.cause })
    this.name = 'UploadError'
    this.code = code
    this.field = options?.field
  }
}
