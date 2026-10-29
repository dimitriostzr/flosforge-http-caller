import { describe, expect, it } from 'vitest'
import { CODEGEN_TARGETS, generateCode } from '../src/shared/codegen'
import { parseCurl } from '../src/shared/importers/curl'
import type { PreparedRequest } from '../src/shared/types'

type Req = Pick<PreparedRequest, 'method' | 'url' | 'headers' | 'body'>

const jsonPost: Req = {
  method: 'POST',
  url: 'https://api.test/users?team=a&x=1',
  headers: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer abc'],
    ['Content-Length', '42']
  ],
  body: { type: 'text', text: '{"name":"O\'Brien"}' }
}

const multipart: Req = {
  method: 'POST',
  url: 'https://api.test/upload',
  headers: [
    ['Content-Type', 'multipart/form-data'],
    ['X-Trace', '1']
  ],
  body: {
    type: 'multipart',
    fields: [
      { name: 'caption', value: 'hi there' },
      { name: 'avatar', filePath: '/home/me/pic.png', contentType: 'image/png' }
    ]
  }
}

const fileBody: Req = { method: 'PUT', url: 'https://api.test/blob', headers: [], body: { type: 'file', path: '/tmp/data.bin' } }
const get: Req = { method: 'GET', url: 'https://api.test/', headers: [['Accept', '*/*']], body: { type: 'none' } }

describe('codegen', () => {
  it('lists all targets', () => {
    expect(CODEGEN_TARGETS.map((t) => t.id)).toEqual(['curl', 'fetch', 'python', 'httpie', 'go'])
  })

  it('never prints content-length', () => {
    for (const { id } of CODEGEN_TARGETS) {
      expect(generateCode(id, jsonPost).toLowerCase()).not.toContain('content-length')
    }
  })

  describe('curl', () => {
    it('escapes single quotes and uses continuations', () => {
      const out = generateCode('curl', jsonPost)
      expect(out).toContain(`curl 'https://api.test/users?team=a&x=1' \\\n  --request POST`)
      expect(out).toContain(`--header 'Authorization: Bearer abc'`)
      expect(out).toContain(`--data-raw '{"name":"O'\\''Brien"}'`)
    })

    it('omits the method for GET and uses --head for HEAD', () => {
      expect(generateCode('curl', get)).toBe(`curl 'https://api.test/' \\\n  --header 'Accept: */*'`)
      expect(generateCode('curl', { ...get, method: 'HEAD' })).toContain('--head')
    })

    it('renders multipart and file bodies', () => {
      const out = generateCode('curl', multipart)
      expect(out).toContain(`--form 'caption=hi there'`)
      expect(out).toContain(`--form 'avatar=@/home/me/pic.png;type=image/png'`)
      expect(out).not.toContain('multipart/form-data')
      expect(generateCode('curl', fileBody)).toContain(`--data-binary '@/tmp/data.bin'`)
    })

    it('round-trips through parseCurl', () => {
      const back = parseCurl(generateCode('curl', jsonPost))
      expect(back.method).toBe('POST')
      expect(back.url).toBe(jsonPost.url)
      expect(back.auth).toEqual({ type: 'bearer', bearer: { token: 'abc' } })
      expect(back.headers.map((h) => [h.key, h.value])).toEqual([['Content-Type', 'application/json']])
      expect(JSON.parse(back.body.raw)).toEqual({ name: "O'Brien" })

      const text: Req = {
        method: 'PATCH',
        url: 'https://api.test/t',
        headers: [['Content-Type', 'text/plain'], ['X-Empty', '']],
        body: { type: 'text', text: "it's\nmulti-line & 'quoted'" }
      }
      const t = parseCurl(generateCode('curl', text))
      expect(t.method).toBe('PATCH')
      expect(t.headers.map((h) => [h.key, h.value])).toEqual([
        ['Content-Type', 'text/plain'],
        ['X-Empty', '']
      ])
      expect(t.body.raw).toBe(text.body.type === 'text' ? text.body.text : '')

      const m = parseCurl(generateCode('curl', multipart))
      expect(m.body.formdata.map((f) => [f.key, f.kind, f.value, f.files])).toEqual([
        ['caption', 'text', 'hi there', undefined],
        ['avatar', 'file', '', ['/home/me/pic.png']]
      ])
    })
  })

  describe('fetch', () => {
    it('renders headers and a text body', () => {
      const out = generateCode('fetch', jsonPost)
      expect(out).toContain(`await fetch('https://api.test/users?team=a&x=1', {`)
      expect(out).toContain(`method: 'POST'`)
      expect(out).toContain(`'Authorization': 'Bearer abc'`)
      expect(out).toContain(`body: '{"name":"O\\'Brien"}'`)
      expect(out).toContain('await response.text()')
    })

    it('uses FormData for multipart', () => {
      const out = generateCode('fetch', multipart)
      expect(out).toContain('const formData = new FormData()')
      expect(out).toContain(`formData.append('caption', 'hi there')`)
      expect(out).toContain(`formData.append('avatar', fileInput.files[0], 'pic.png')`)
      expect(out).toContain('body: formData')
      expect(out).not.toMatch(/multipart\/form-data/)
    })

    it('uses a template literal for multi-line bodies', () => {
      const out = generateCode('fetch', { ...jsonPost, body: { type: 'text', text: 'a\n`b` ${c}' } })
      expect(out).toContain('body: `a\n\\`b\\` \\${c}`')
    })
  })

  describe('python', () => {
    it('uses requests with data=', () => {
      const out = generateCode('python', jsonPost)
      expect(out).toContain('import requests')
      expect(out).toContain(`url = 'https://api.test/users?team=a&x=1'`)
      expect(out).toContain(`'Authorization': 'Bearer abc',`)
      expect(out).toContain(`data = '{"name":"O\\'Brien"}'`)
      expect(out).toContain(`response = requests.request('POST', url, headers=headers, data=data)`)
    })

    it('encodes non-ASCII bodies and uses files= for multipart', () => {
      expect(generateCode('python', { ...jsonPost, body: { type: 'text', text: 'héllo\n' } })).toContain(
        `data = 'héllo\\n'.encode('utf-8')`
      )
      const out = generateCode('python', multipart)
      expect(out).toContain(`('caption', (None, 'hi there')),`)
      expect(out).toContain(`('avatar', ('pic.png', open('/home/me/pic.png', 'rb'), 'image/png')),`)
      expect(out).toContain('files=files')
      expect(generateCode('python', fileBody)).toContain(`data = open('/tmp/data.bin', 'rb')`)
    })
  })

  describe('httpie', () => {
    it('renders method, url, headers and raw body', () => {
      const out = generateCode('httpie', jsonPost)
      expect(out).toContain(`http --raw '{"name":"O'\\''Brien"}' POST 'https://api.test/users?team=a&x=1'`)
      expect(out).toContain(`'Authorization:Bearer abc'`)
    })

    it('renders multipart and file bodies', () => {
      const out = generateCode('httpie', multipart)
      expect(out).toContain('http --multipart POST')
      expect(out).toContain(`'caption=hi there'`)
      expect(out).toContain(`'avatar@/home/me/pic.png;type=image/png'`)
      expect(generateCode('httpie', fileBody)).toContain(`< '/tmp/data.bin'`)
    })
  })

  describe('go', () => {
    it('renders a complete program', () => {
      const out = generateCode('go', jsonPost)
      expect(out).toContain('package main')
      expect(out).toContain('"strings"')
      expect(out).toContain('body := strings.NewReader("{\\"name\\":\\"O\'Brien\\"}")')
      expect(out).toContain('http.NewRequest("POST", "https://api.test/users?team=a&x=1", body)')
      expect(out).toContain('req.Header.Add("Authorization", "Bearer abc")')
      expect(out).toContain('io.ReadAll(res.Body)')
    })

    it('uses nil for empty bodies and multipart.Writer for forms', () => {
      const g = generateCode('go', get)
      expect(g).toContain('http.NewRequest("GET", "https://api.test/", nil)')
      expect(g).not.toContain('"strings"')
      const m = generateCode('go', multipart)
      expect(m).toContain('writer := multipart.NewWriter(payload)')
      expect(m).toContain('_ = writer.WriteField("caption", "hi there")')
      expect(m).toContain('attach("avatar", "/home/me/pic.png")')
      expect(m).toContain('req.Header.Set("Content-Type", writer.FormDataContentType())')
      expect(m).toContain('"path/filepath"')
      expect(generateCode('go', fileBody)).toContain('body, err := os.Open("/tmp/data.bin")')
    })
  })
})
