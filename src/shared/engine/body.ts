export function getHeader(headers: [string, string][], name: string): string | undefined {
  const n = name.toLowerCase()
  return headers.find(([k]) => k.toLowerCase() === n)?.[1]
}

/** Decodes a response body using the charset from its Content-Type (UTF-8 by default). */
export function decodeBody(body: Uint8Array, headers: [string, string][]): string {
  const ct = getHeader(headers, 'content-type') ?? ''
  const charset = /charset=["']?([\w-]+)/i.exec(ct)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}
