export interface Disposition {
  name?: string
  filename?: string
}

/**
 * Reads `name` and `filename` from a part's Content-Disposition header, e.g.
 * `form-data; name="avatar"; filename="me.png"`.
 * `filename*` (RFC 5987, used for non-ASCII names) wins over `filename`.
 */
export function parseDisposition(header: string | undefined): Disposition {
  const params: Record<string, string> = {}
  if (!header) return {}

  // skip the type ("form-data") and read `; key=value` pairs
  let i = header.indexOf(';')
  while (i !== -1 && i < header.length) {
    i++
    while (header[i] === ' ' || header[i] === '\t') i++
    const eq = header.indexOf('=', i)
    if (eq === -1) break
    const key = header.slice(i, eq).trim().toLowerCase()
    let value: string
    i = eq + 1
    if (header[i] === '"') {
      // quoted value, `\"` and `\\` are escapes
      value = ''
      i++
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < header.length) i++
        value += header[i]
        i++
      }
      i = header.indexOf(';', i)
    } else {
      const end = header.indexOf(';', i)
      value = (end === -1 ? header.slice(i) : header.slice(i, end)).trim()
      i = end
    }
    if (key && !(key in params)) params[key] = value
  }

  let filename = params.filename
  const extended = params['filename*']
  if (extended !== undefined) {
    const decoded = decodeExtended(extended)
    if (decoded !== undefined) filename = decoded
  }

  return { name: params.name, filename }
}

// UTF-8''na%C3%AFve.txt
function decodeExtended(value: string): string | undefined {
  const match = /^([\w!#$%&+^`{}~-]*)'[\w-]*'(.*)$/.exec(value)
  if (!match) return undefined
  const charset = match[1].toLowerCase()
  if (charset !== 'utf-8' && charset !== '') return undefined
  try {
    return decodeURIComponent(match[2])
  } catch {
    return undefined
  }
}
