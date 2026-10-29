import { describe, expect, it } from 'vitest'
import { parseCurl, tokenize } from '../src/shared/importers/curl'

const headerMap = (r: ReturnType<typeof parseCurl>): Record<string, string> =>
  Object.fromEntries(r.headers.map((h) => [h.key.toLowerCase(), h.value]))

describe('tokenize', () => {
  it('handles quotes, escapes and continuations', () => {
    expect(tokenize(`curl 'a b' "c \\"d\\" \\$e \\x" f\\ g \\\n h`)).toEqual(['curl', 'a b', 'c "d" $e \\x', 'f g', 'h'])
    expect(tokenize(`curl $'it\\'s\\n\\x41\\u00e9\\t'`)).toEqual(['curl', "it's\nAé\t"])
    expect(tokenize(`curl 'a'"b"c ''`)).toEqual(['curl', 'abc', ''])
  })
})

describe('parseCurl', () => {
  it('parses Chrome "Copy as cURL (bash)"', () => {
    const cmd = `curl 'https://api.example.com/v1/users?page=2&limit=10' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer eyJhbGciOi.payload.sig' \\
  -H 'content-type: application/json' \\
  -H 'origin: https://app.example.com' \\
  -H 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64)' \\
  --data-raw '{"name":"Ada","tags":["a","b"]}' \\
  --compressed`
    const r = parseCurl(cmd)
    expect(r.method).toBe('POST')
    expect(r.name).toBe('POST /v1/users')
    expect(r.url).toBe('https://api.example.com/v1/users?page=2&limit=10')
    expect(r.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '2', true],
      ['limit', '10', true]
    ])
    expect(r.auth).toEqual({ type: 'bearer', bearer: { token: 'eyJhbGciOi.payload.sig' } })
    const h = headerMap(r)
    expect(h.authorization).toBeUndefined()
    expect(h['sec-ch-ua']).toBe('"Chromium";v="124", "Not-A.Brand";v="99"')
    expect(h['accept-language']).toBe('en-US,en;q=0.9')
    expect(r.headers).toHaveLength(6)
    expect(r.body.mode).toBe('raw')
    expect(r.body.rawLanguage).toBe('json')
    expect(r.body.raw).toBe(JSON.stringify({ name: 'Ada', tags: ['a', 'b'] }, null, 2))
  })

  it('parses Firefox-style commands', () => {
    const cmd = `curl 'https://example.org/api/search' -X POST -H 'User-Agent: Mozilla/5.0 (X11; rv:125.0) Gecko/20100101 Firefox/125.0' -H 'Accept: */*' -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' -H 'Connection: keep-alive' --data-raw 'q=hello+world&lang=en%2Fus'`
    const r = parseCurl(cmd)
    expect(r.method).toBe('POST')
    expect(r.body.mode).toBe('urlencoded')
    expect(r.body.urlencoded.map((p) => [p.key, p.value])).toEqual([
      ['q', 'hello world'],
      ['lang', 'en/us']
    ])
    expect(headerMap(r)['user-agent']).toContain('Firefox/125.0')
  })

  it("supports $'...' quoting", () => {
    const r = parseCurl(`curl 'https://x.test/notes' -H 'Content-Type: text/plain' --data-raw $'line one\\nit\\'s line two'`)
    expect(r.body).toMatchObject({ mode: 'raw', rawLanguage: 'text', raw: "line one\nit's line two" })
  })

  it('maps -u to basic auth', () => {
    const r = parseCurl('curl -u alice:s3:cr3t https://x.test/me')
    expect(r.auth).toEqual({ type: 'basic', basic: { username: 'alice', password: 's3:cr3t' } })
    expect(r.method).toBe('GET')
    expect(r.name).toBe('GET /me')
  })

  it('parses -F form fields with files', () => {
    const r = parseCurl(`curl -F 'caption=My photo' -F 'avatar=@/home/me/pic.png;type=image/png' --form-string 'raw=@not-a-file' https://x.test/upload`)
    expect(r.method).toBe('POST')
    expect(r.body.mode).toBe('formdata')
    expect(r.body.formdata.map((f) => [f.key, f.kind, f.value, f.files, f.contentType])).toEqual([
      ['caption', 'text', 'My photo', undefined, undefined],
      ['avatar', 'file', '', ['/home/me/pic.png'], 'image/png'],
      ['raw', 'text', '@not-a-file', undefined, undefined]
    ])
  })

  it('moves data into the query string with -G', () => {
    const r = parseCurl(`curl -G https://x.test/search?a=1 -d q=cats --data-urlencode 'tag=big dogs'`)
    expect(r.method).toBe('GET')
    expect(r.url).toBe('https://x.test/search?a=1&q=cats&tag=big+dogs')
    expect(r.params.map((p) => [p.key, p.value])).toEqual([
      ['a', '1'],
      ['q', 'cats'],
      ['tag', 'big+dogs']
    ])
    expect(r.body.mode).toBe('none')
  })

  it('supports --json', () => {
    const r = parseCurl(`curl --json '{"a":1}' https://x.test/items`)
    expect(r.method).toBe('POST')
    expect(r.body).toMatchObject({ mode: 'raw', rawLanguage: 'json', raw: '{\n  "a": 1\n}' })
    expect(headerMap(r)).toEqual({ 'content-type': 'application/json', accept: 'application/json' })
  })

  it('detects urlencoded data without a content type', () => {
    const r = parseCurl(`curl https://x.test/login -d 'user=bob' -d 'pass=a%26b'`)
    expect(r.method).toBe('POST')
    expect(r.body.mode).toBe('urlencoded')
    expect(r.body.urlencoded.map((p) => [p.key, p.value])).toEqual([
      ['user', 'bob'],
      ['pass', 'a&b']
    ])
  })

  it('falls back to raw text for other data', () => {
    const r = parseCurl(`curl -X PUT https://x.test/t -d 'hello there'`)
    expect(r.method).toBe('PUT')
    expect(r.body).toMatchObject({ mode: 'raw', rawLanguage: 'text', raw: 'hello there' })
  })

  it('treats --data-binary @file as a binary body', () => {
    const r = parseCurl(`curl --data-binary @/tmp/payload.bin -H 'Content-Type: application/octet-stream' https://x.test/up`)
    expect(r.body).toMatchObject({ mode: 'binary', binaryPath: '/tmp/payload.bin' })
  })

  it('handles misc flags, clusters and header shortcuts', () => {
    const r = parseCurl(
      `curl -sSLk --max-time 10 -o out.json -XPATCH -A 'agent/1' -e https://ref.test -b 'a=1; b=2' -b cookies.txt --url 'https://x.test/p?x' --unknown-flag`
    )
    expect(r.method).toBe('PATCH')
    expect(r.url).toBe('https://x.test/p?x')
    expect(headerMap(r)).toEqual({ 'user-agent': 'agent/1', referer: 'https://ref.test', cookie: 'a=1; b=2' })
  })

  it('does not let unknown value flags swallow the URL', () => {
    const r = parseCurl(`curl --some-new-option value https://x.test/ok`)
    expect(r.url).toBe('https://x.test/ok')
  })

  it('handles -I and XML bodies', () => {
    expect(parseCurl('curl -I https://x.test').method).toBe('HEAD')
    const xml = parseCurl(`curl https://x.test/soap -H 'Content-Type: text/xml' -d '<a>1</a>'`)
    expect(xml.body).toMatchObject({ mode: 'raw', rawLanguage: 'xml', raw: '<a>1</a>' })
  })

  it('parses Windows cmd-style commands', () => {
    const cmd = [
      'curl ^"https://x.test/api?q=1^" ^',
      '  -H ^"content-type: application/json^" ^',
      '  --data-raw ^"^{^\\^"a^\\^":1^}^"'
    ].join('\n')
    const r = parseCurl(cmd)
    expect(r.url).toBe('https://x.test/api?q=1')
    expect(headerMap(r)['content-type']).toBe('application/json')
    expect(r.body.raw).toBe('{\n  "a": 1\n}')
  })

  it('keeps {{variables}} and URLs without a scheme', () => {
    const r = parseCurl(`curl '{{baseUrl}}/users/{{id}}' -H 'Authorization: Bearer {{token}}'`)
    expect(r.url).toBe('{{baseUrl}}/users/{{id}}')
    expect(r.name).toBe('GET /users/{{id}}')
    expect(r.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } })
  })

  it('rejects non-curl input', () => {
    expect(() => parseCurl('wget https://x.test')).toThrow('Not a cURL command')
    expect(() => parseCurl('')).toThrow('Not a cURL command')
  })
})
