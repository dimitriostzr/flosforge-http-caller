import type { PreparedFormField, PreparedRequest } from './types'

export type CodegenTarget = 'curl' | 'fetch' | 'python' | 'httpie' | 'go'

export const CODEGEN_TARGETS: { id: CodegenTarget; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'JavaScript (fetch)' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'httpie', label: 'HTTPie' },
  { id: 'go', label: 'Go (net/http)' }
]

type CodegenRequest = Pick<PreparedRequest, 'method' | 'url' | 'headers' | 'body'>

// ---------------------------------------------------------------------------
// Helpers

/** Headers worth printing: no content-length, and no multipart content-type (clients add the boundary). */
function snippetHeaders(req: CodegenRequest): [string, string][] {
  return req.headers.filter(([k]) => {
    const lower = k.toLowerCase()
    if (lower === 'content-length') return false
    if (lower === 'content-type' && req.body.type === 'multipart') return false
    return true
  })
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() || 'file'

/** POSIX shell single-quoting. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const escapeControl = (s: string, uni: (code: number) => string): string =>
  s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => {
    switch (c) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
    }
    return uni(c.charCodeAt(0))
  })

const hex4 = (code: number): string => code.toString(16).padStart(4, '0')

/** JavaScript single-quoted string literal. */
const jsStr = (s: string): string =>
  `'${escapeControl(s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), (c) => `\\u${hex4(c)}`)}'`

/** JavaScript template literal (for multi-line bodies). */
const jsTemplate = (s: string): string => `\`${s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``

/** Python single-quoted string literal. */
const pyStr = (s: string): string =>
  `'${escapeControl(s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), (c) => (c < 0x100 ? `\\x${c.toString(16).padStart(2, '0')}` : `\\u${hex4(c)}`))}'`

/** Go interpreted string literal. */
const goStr = (s: string): string =>
  `"${escapeControl(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'), (c) => `\\u${hex4(c)}`)}"`

/** Go raw string when it reads better (multi-line, no backticks / CRs). */
const goBodyStr = (s: string): string => (s.includes('\n') && !/[`\r]/.test(s) ? `\`${s}\`` : goStr(s))

// ---------------------------------------------------------------------------
// cURL

function curlForm(f: PreparedFormField): string {
  if (f.filePath !== undefined) {
    const path = /[;",]/.test(f.filePath) ? `"${f.filePath.replace(/(["\\])/g, '\\$1')}"` : f.filePath
    return `--form ${shQuote(`${f.name}=@${path}${f.contentType ? `;type=${f.contentType}` : ''}`)}`
  }
  const value = f.value ?? ''
  // --form would treat a leading @ or < as a file reference
  if (/^[@<]/.test(value) || value.includes(';')) return `--form-string ${shQuote(`${f.name}=${value}`)}`
  return `--form ${shQuote(`${f.name}=${value}${f.contentType ? `;type=${f.contentType}` : ''}`)}`
}

function genCurl(req: CodegenRequest): string {
  const lines = [`curl ${shQuote(req.url)}`]
  const method = req.method.toUpperCase()
  if (method === 'HEAD') lines.push('--head')
  else if (method !== 'GET') lines.push(`--request ${method}`)
  for (const [k, v] of snippetHeaders(req)) lines.push(`--header ${shQuote(v === '' ? `${k};` : `${k}: ${v}`)}`)
  const b = req.body
  if (b.type === 'text') lines.push(`--data-raw ${shQuote(b.text)}`)
  else if (b.type === 'file') lines.push(`--data-binary ${shQuote(`@${b.path}`)}`)
  else if (b.type === 'multipart') for (const f of b.fields) lines.push(curlForm(f))
  return lines.join(' \\\n  ')
}

// ---------------------------------------------------------------------------
// JavaScript fetch

function genFetch(req: CodegenRequest): string {
  const out: string[] = []
  const opts: string[] = [`  method: ${jsStr(req.method.toUpperCase())}`]
  const headers = snippetHeaders(req)
  if (headers.length) {
    const lowered = headers.map(([k]) => k.toLowerCase())
    const hasDupes = new Set(lowered).size !== lowered.length
    const entries = headers.map(([k, v]) => (hasDupes ? `    [${jsStr(k)}, ${jsStr(v)}]` : `    ${jsStr(k)}: ${jsStr(v)}`))
    opts.push(hasDupes ? `  headers: [\n${entries.join(',\n')}\n  ]` : `  headers: {\n${entries.join(',\n')}\n  }`)
  }
  const b = req.body
  if (b.type === 'text') {
    opts.push(`  body: ${b.text.includes('\n') ? jsTemplate(b.text) : jsStr(b.text)}`)
  } else if (b.type === 'file') {
    out.push(`// Pick the file to upload, e.g. from <input type="file">: ${b.path}`)
    out.push(`const file = fileInput.files[0]`, '')
    opts.push('  body: file')
  } else if (b.type === 'multipart') {
    out.push('const formData = new FormData()')
    for (const f of b.fields) {
      if (f.filePath !== undefined) {
        out.push(`// TODO: attach file ${f.filePath}`)
        out.push(`formData.append(${jsStr(f.name)}, fileInput.files[0], ${jsStr(fileName(f.filePath))})`)
      } else {
        out.push(`formData.append(${jsStr(f.name)}, ${jsStr(f.value ?? '')})`)
      }
    }
    out.push('')
    opts.push('  body: formData')
  }
  out.push(`const response = await fetch(${jsStr(req.url)}, {\n${opts.join(',\n')}\n})`)
  out.push('', 'console.log(response.status)', 'console.log(await response.text())')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Python requests

function genPython(req: CodegenRequest): string {
  const out = ['import requests', '', `url = ${pyStr(req.url)}`]
  const args = [pyStr(req.method.toUpperCase()), 'url']
  const headers = snippetHeaders(req)
  if (headers.length) {
    // A list of tuples would also keep duplicates, but requests wants a mapping.
    const merged = new Map<string, [string, string]>()
    for (const [k, v] of headers) {
      const prev = merged.get(k.toLowerCase())
      merged.set(k.toLowerCase(), prev ? [prev[0], `${prev[1]}, ${v}`] : [k, v])
    }
    out.push(`headers = {\n${[...merged.values()].map(([k, v]) => `    ${pyStr(k)}: ${pyStr(v)},`).join('\n')}\n}`)
    args.push('headers=headers')
  }
  const b = req.body
  if (b.type === 'text') {
    // requests encodes str bodies as latin-1, so non-ASCII text must be encoded explicitly
    out.push(`data = ${pyStr(b.text)}${/[^\x00-\x7f]/.test(b.text) ? ".encode('utf-8')" : ''}`)
    args.push('data=data')
  } else if (b.type === 'file') {
    out.push(`data = open(${pyStr(b.path)}, 'rb')`)
    args.push('data=data')
  } else if (b.type === 'multipart') {
    const entries = b.fields.map((f) => {
      if (f.filePath !== undefined) {
        const parts = [pyStr(fileName(f.filePath)), `open(${pyStr(f.filePath)}, 'rb')`]
        if (f.contentType) parts.push(pyStr(f.contentType))
        return `    (${pyStr(f.name)}, (${parts.join(', ')})),`
      }
      return `    (${pyStr(f.name)}, (None, ${pyStr(f.value ?? '')})),`
    })
    out.push(`files = [\n${entries.join('\n')}\n]`)
    args.push('files=files')
  }
  out.push('', `response = requests.request(${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// HTTPie

function genHttpie(req: CodegenRequest): string {
  const b = req.body
  const first: string[] = ['http']
  if (b.type === 'text') first.push(`--raw ${shQuote(b.text)}`)
  if (b.type === 'multipart') first.push('--multipart')
  first.push(req.method.toUpperCase(), shQuote(req.url))
  const lines = [first.join(' ')]
  for (const [k, v] of snippetHeaders(req)) lines.push(shQuote(v === '' ? `${k};` : `${k}:${v}`))
  if (b.type === 'multipart') {
    for (const f of b.fields) {
      if (f.filePath !== undefined) {
        lines.push(shQuote(`${f.name}@${f.filePath}${f.contentType ? `;type=${f.contentType}` : ''}`))
      } else {
        lines.push(shQuote(`${f.name}=${f.value ?? ''}`))
      }
    }
  }
  let cmd = lines.join(' \\\n  ')
  if (b.type === 'file') cmd += ` \\\n  < ${shQuote(b.path)}`
  return cmd
}

// ---------------------------------------------------------------------------
// Go net/http

function genGo(req: CodegenRequest): string {
  const imports = new Set(['fmt', 'io', 'net/http'])
  const body: string[] = []
  let reader = 'nil'
  const b = req.body
  if (b.type === 'text') {
    imports.add('strings')
    body.push(`\tbody := strings.NewReader(${goBodyStr(b.text)})`)
    reader = 'body'
  } else if (b.type === 'file') {
    imports.add('os')
    body.push(
      `\tbody, err := os.Open(${goStr(b.path)})`,
      '\tif err != nil {',
      '\t\tpanic(err)',
      '\t}',
      '\tdefer body.Close()'
    )
    reader = 'body'
  } else if (b.type === 'multipart') {
    imports.add('bytes').add('mime/multipart')
    body.push('\tpayload := &bytes.Buffer{}', '\twriter := multipart.NewWriter(payload)')
    if (b.fields.some((f) => f.filePath !== undefined)) {
      imports.add('os').add('path/filepath')
      body.push(
        '\tattach := func(field, path string) {',
        '\t\tf, err := os.Open(path)',
        '\t\tif err != nil {',
        '\t\t\tpanic(err)',
        '\t\t}',
        '\t\tdefer f.Close()',
        '\t\tpart, err := writer.CreateFormFile(field, filepath.Base(path))',
        '\t\tif err != nil {',
        '\t\t\tpanic(err)',
        '\t\t}',
        '\t\tif _, err := io.Copy(part, f); err != nil {',
        '\t\t\tpanic(err)',
        '\t\t}',
        '\t}'
      )
    }
    for (const f of b.fields) {
      if (f.filePath !== undefined) body.push(`\tattach(${goStr(f.name)}, ${goStr(f.filePath)})`)
      else body.push(`\t_ = writer.WriteField(${goStr(f.name)}, ${goStr(f.value ?? '')})`)
    }
    body.push('\tif err := writer.Close(); err != nil {', '\t\tpanic(err)', '\t}')
    reader = 'payload'
  }
  if (body.length) body.push('')
  body.push(
    `\treq, err := http.NewRequest(${goStr(req.method.toUpperCase())}, ${goStr(req.url)}, ${reader})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}'
  )
  for (const [k, v] of snippetHeaders(req)) body.push(`\treq.Header.Add(${goStr(k)}, ${goStr(v)})`)
  if (b.type === 'multipart') body.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())')
  body.push(
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer res.Body.Close()',
    '',
    '\tdata, err := io.ReadAll(res.Body)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tfmt.Println(res.Status)',
    '\tfmt.Println(string(data))'
  )
  const importBlock = [...imports].sort().map((i) => `\t"${i}"`).join('\n')
  return `package main\n\nimport (\n${importBlock}\n)\n\nfunc main() {\n${body.join('\n')}\n}\n`
}

// ---------------------------------------------------------------------------

export function generateCode(target: CodegenTarget, req: CodegenRequest): string {
  switch (target) {
    case 'curl':
      return genCurl(req)
    case 'fetch':
      return genFetch(req)
    case 'python':
      return genPython(req)
    case 'httpie':
      return genHttpie(req)
    case 'go':
      return genGo(req)
  }
  throw new Error(`Unknown code generation target: ${target as string}`)
}
