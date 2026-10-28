import { uid } from '../model'
import { applyPathVariables } from '../url'
import type { ApiRequest, Auth, Collection, Folder, PreparedBody, PreparedFormField, PreparedRequest, RawLanguage } from '../types'
import { findVariableRefs, resolve, type Scopes } from './variables'

export const RAW_CONTENT_TYPES: Record<RawLanguage, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain'
}

/** Walks request → folders → collection until it finds an auth that isn't "inherit". */
export function effectiveAuth(req: ApiRequest, parents: Folder[], collection?: Collection | null): Auth {
  if (req.auth.type !== 'inherit') return req.auth
  for (let i = parents.length - 1; i >= 0; i--) {
    if (parents[i].auth.type !== 'inherit') return parents[i].auth
  }
  if (collection && collection.auth.type !== 'inherit') return collection.auth
  return { type: 'none' }
}

const hasHeader = (headers: [string, string][], name: string): boolean =>
  headers.some(([k]) => k.toLowerCase() === name.toLowerCase())

function b64(s: string): string {
  // btoa only accepts latin1, so go through UTF-8 bytes.
  return btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''))
}

export function prepareRequest(req: ApiRequest, auth: Auth, scopes: Scopes): PreparedRequest {
  const r = (s: string): string => resolve(s, scopes)
  // Path variables first, so their values can use {{variables}} too.
  let url = r(applyPathVariables(req.url.trim(), req.pathVariables))
  const headers: [string, string][] = req.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => [r(h.key.trim()), r(h.value)])

  switch (auth.type) {
    case 'bearer':
      if (auth.bearer?.token && !hasHeader(headers, 'authorization'))
        headers.push(['Authorization', `Bearer ${r(auth.bearer.token)}`])
      break
    case 'basic':
      if (auth.basic && !hasHeader(headers, 'authorization'))
        headers.push(['Authorization', `Basic ${b64(`${r(auth.basic.username)}:${r(auth.basic.password)}`)}`])
      break
    case 'oauth2':
      if (auth.oauth2?.accessToken && !hasHeader(headers, 'authorization')) {
        const prefix = r(auth.oauth2.headerPrefix ?? 'Bearer').trim()
        headers.push(['Authorization', `${prefix ? `${prefix} ` : ''}${r(auth.oauth2.accessToken)}`])
      }
      break
    case 'apikey':
      if (auth.apikey?.key) {
        const key = r(auth.apikey.key)
        const value = r(auth.apikey.value)
        if (auth.apikey.in === 'query') {
          const hashAt = url.indexOf('#')
          const [main, hash] = hashAt === -1 ? [url, ''] : [url.slice(0, hashAt), url.slice(hashAt)]
          const sep = main.includes('?') ? (main.endsWith('?') || main.endsWith('&') ? '' : '&') : '?'
          url = `${main}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`
        } else if (!hasHeader(headers, key)) {
          headers.push([key, value])
        }
      }
      break
  }

  const setType = (type: string): void => {
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', type])
  }

  let body: PreparedBody = { type: 'none' }
  const b = req.body
  switch (b.mode) {
    case 'raw':
      body = { type: 'text', text: r(b.raw) }
      setType(RAW_CONTENT_TYPES[b.rawLanguage] ?? 'text/plain')
      break
    case 'urlencoded':
      body = {
        type: 'text',
        text: b.urlencoded
          .filter((f) => f.enabled && f.key)
          .map((f) => `${encodeURIComponent(r(f.key))}=${encodeURIComponent(r(f.value))}`)
          .join('&')
      }
      setType('application/x-www-form-urlencoded')
      break
    case 'formdata':
      body = {
        type: 'multipart',
        fields: b.formdata
          .filter((f) => f.enabled && f.key)
          .flatMap<PreparedFormField>((f) =>
            f.kind === 'file'
              ? (f.files ?? []).map((path) => ({ name: r(f.key), filePath: path, contentType: f.contentType }))
              : [{ name: r(f.key), value: r(f.value), contentType: f.contentType }]
          )
      }
      break
    case 'binary':
      if (b.binaryPath) body = { type: 'file', path: b.binaryPath }
      break
    case 'graphql': {
      let variables: unknown
      const vars = r(b.graphql.variables).trim()
      if (vars) {
        try {
          variables = JSON.parse(vars)
        } catch {
          throw new Error('GraphQL variables are not valid JSON')
        }
      }
      body = { type: 'text', text: JSON.stringify({ query: r(b.graphql.query), ...(variables ? { variables } : {}) }) }
      setType('application/json')
      break
    }
  }

  return { execId: uid(), method: (r(req.method) || 'GET').toUpperCase(), url, headers, body }
}

/**
 * Variables the request uses that still have no value after resolution (in the
 * order they appear). Nested references are followed, so a defined variable
 * whose value uses an undefined one reports the undefined one.
 */
export function missingVariables(req: ApiRequest, auth: Auth, scopes: Scopes): string[] {
  const texts: string[] = [applyPathVariables(req.url, req.pathVariables), req.method]
  for (const h of req.headers) if (h.enabled) texts.push(h.key, h.value)
  const b = req.body
  if (b.mode === 'raw') texts.push(b.raw)
  if (b.mode === 'urlencoded') for (const f of b.urlencoded) if (f.enabled) texts.push(f.key, f.value)
  if (b.mode === 'formdata') for (const f of b.formdata) if (f.enabled) texts.push(f.key, f.kind === 'text' ? f.value : '')
  if (b.mode === 'graphql') texts.push(b.graphql.query, b.graphql.variables)
  if (auth.type === 'bearer') texts.push(auth.bearer?.token ?? '')
  if (auth.type === 'basic') texts.push(auth.basic?.username ?? '', auth.basic?.password ?? '')
  if (auth.type === 'apikey') texts.push(auth.apikey?.key ?? '', auth.apikey?.value ?? '')
  if (auth.type === 'oauth2') texts.push(auth.oauth2?.accessToken ?? '', auth.oauth2?.headerPrefix ?? '')
  const out: string[] = []
  for (const t of texts) for (const r of findVariableRefs(resolve(t, scopes))) if (!out.includes(r.name)) out.push(r.name)
  return out
}
