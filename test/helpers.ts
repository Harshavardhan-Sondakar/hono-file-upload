export const BOUNDARY = '----test-boundary-7MA4YWxkTrZu0gW'

type RawPart = {
  disposition: string
  type?: string
  body: string | Uint8Array
}

/** Build a multipart body by hand, for cases FormData can't produce. */
export function rawMultipart(parts: RawPart[], boundary = BOUNDARY): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: ${part.disposition}\r\n`
    if (part.type) head += `Content-Type: ${part.type}\r\n`
    chunks.push(enc.encode(`${head}\r\n`))
    chunks.push(typeof part.body === 'string' ? enc.encode(part.body) : part.body)
    chunks.push(enc.encode('\r\n'))
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function rawRequest(body: BodyInit, boundary = BOUNDARY): RequestInit & { duplex: 'half' } {
  return {
    method: 'POST',
    body,
    // needed by Node to send a stream as a request body
    duplex: 'half',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

export function form(entries: [string, string | File][]): RequestInit {
  const fd = new FormData()
  for (const [k, v] of entries) fd.append(k, v)
  return { method: 'POST', body: fd }
}

export const file = (content: string, name: string, type = 'text/plain') => new File([content], name, { type })

/** A multipart body with one generated file of `size` bytes, produced chunk by chunk. */
export function bigFileStream(size: number, chunk = 1024 * 1024): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let sent = 0
  let started = false
  return new ReadableStream({
    pull(c) {
      if (!started) {
        started = true
        c.enqueue(
          enc.encode(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="big"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
        )
        return
      }
      if (sent >= size) {
        c.enqueue(enc.encode(`\r\n--${BOUNDARY}--\r\n`))
        c.close()
        return
      }
      const n = Math.min(chunk, size - sent)
      c.enqueue(new Uint8Array(n).fill(120))
      sent += n
    },
  })
}
