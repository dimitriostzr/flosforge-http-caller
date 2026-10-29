import { X509Certificate } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import tls from 'node:tls'
import type { CertificateSettings, ClientCertificate } from '@shared/types'
import { ExecError } from './errors'

// Trust and identity for https: extra CA certificates (files, or the ones the
// operating system trusts) and client certificates for mutual TLS, per host.
// The result is one TLS secure context, cached until a file or setting changes.

/** `api.example.com`, `*.example.com` (subdomains only) or `*`, optionally with `:port`. */
export function hostMatches(pattern: string, hostname: string, port: string): boolean {
  let p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  let wantPort: string | undefined
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(p)
  const named = /^([^:]+):(\d+)$/.exec(p)
  if (v6) [, p, wantPort] = v6
  else if (named) [, p, wantPort] = named
  if (!p || (wantPort && wantPort !== port)) return false
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (p === '*') return true
  if (p.startsWith('*.')) return host.endsWith(p.slice(1))
  return host === p
}

export function clientCertificateFor(url: URL, certs: CertificateSettings | undefined): ClientCertificate | undefined {
  const port = url.port || '443'
  return certs?.client.find((c) => c.enabled && (c.certPath || c.pfxPath) && hostMatches(c.host, url.hostname, port))
}

let systemCas: string[] | undefined

/** Node's own list plus NODE_EXTRA_CA_CERTS: what https trusts when no `ca` is given. */
function defaultCas(): readonly string[] {
  return typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : tls.rootCertificates
}

function osCas(): string[] {
  if (typeof tls.getCACertificates !== 'function') {
    throw new ExecError('Trusting the operating system certificates needs Node.js 22.15 or later', 'ECERTFILE')
  }
  systemCas ??= tls.getCACertificates('system')
  return systemCas
}

async function readCertFile(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (e) {
    throw new ExecError(`Could not read the ${what} ${path} (${(e as Error).message})`, 'ECERTFILE')
  }
}

/** PEM text as is (it may hold several certificates); DER (.cer, .der) converted to PEM. */
async function caFromFile(path: string): Promise<string> {
  const data = await readCertFile(path, 'CA certificate')
  const text = data.toString('latin1')
  if (text.includes('-----BEGIN')) return text
  try {
    return new X509Certificate(data).toString()
  } catch {
    throw new ExecError(`${path} is not a PEM or DER certificate`, 'ECERTFILE')
  }
}

const cache = new Map<string, tls.SecureContext>()

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return -1
  }
}

/**
 * The secure context for a request to `url`, or undefined when the defaults do
 * (no extra CAs, no client certificate for this host).
 */
export async function secureContextFor(url: URL, certs: CertificateSettings | undefined): Promise<tls.SecureContext | undefined> {
  if (!certs) return undefined
  const caPaths = certs.caPaths.filter((p) => p.trim())
  const client = clientCertificateFor(url, certs)
  if (!certs.useSystemCa && !caPaths.length && !client) return undefined

  const files = [...caPaths, ...(client ? [client.certPath, client.keyPath, client.pfxPath].filter(Boolean) : [])]
  const key = JSON.stringify([
    certs.useSystemCa,
    caPaths,
    client && [client.certPath, client.keyPath, client.pfxPath, client.passphrase],
    await Promise.all(files.map(mtime))
  ])
  const hit = cache.get(key)
  if (hit) return hit

  const ca: string[] = []
  if (certs.useSystemCa || caPaths.length) {
    ca.push(...defaultCas())
    if (certs.useSystemCa) ca.push(...osCas())
    for (const p of caPaths) ca.push(await caFromFile(p))
  }
  const options: tls.SecureContextOptions = ca.length ? { ca } : {}
  if (client) {
    if (client.pfxPath) options.pfx = await readCertFile(client.pfxPath, 'client certificate')
    else {
      options.cert = await readCertFile(client.certPath, 'client certificate')
      if (client.keyPath) options.key = await readCertFile(client.keyPath, 'client certificate key')
    }
    if (client.passphrase) options.passphrase = client.passphrase
  }

  let context: tls.SecureContext
  try {
    context = tls.createSecureContext(options)
  } catch (e) {
    const msg = (e as Error).message
    const why = /bad decrypt|mac verify|bad password|wrong tag/i.test(msg) ? 'wrong passphrase' : msg
    throw new ExecError(
      client
        ? `Could not use the client certificate for ${client.host}: ${why}`
        : `Could not load the CA certificates: ${msg}`,
      'ECERTFILE'
    )
  }
  if (cache.size > 16) cache.clear()
  cache.set(key, context)
  return context
}
