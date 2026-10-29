import type { HttpResponse, PreparedRequest } from '../types'
import { decodeBody, getHeader } from './body'
import type { RunStep, RunSummary } from './collectionRun'
import type { LogEntry, TestResult } from './scriptTypes'

// Human-readable exports of a single response and of a collection run, as
// Markdown, plain text, HTML (printed to PDF by the app), CSV and JSON.

export type ReportFormat = 'md' | 'txt' | 'pdf' | 'csv' | 'json'

export const REPORT_FORMATS: { id: ReportFormat; label: string; ext: string }[] = [
  { id: 'md', label: 'Markdown', ext: 'md' },
  { id: 'txt', label: 'Plain text', ext: 'txt' },
  { id: 'pdf', label: 'PDF', ext: 'pdf' },
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'json', label: 'JSON', ext: 'json' }
]

// --- Shared helpers ---------------------------------------------------------------

/** Headers that carry credentials: masked in reports, dropped on cross-origin redirects. */
export const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i

/** Reports get shared; tokens and cookies in them shouldn't be. Keeps a hint of the value. */
export function maskHeader(name: string, value: string): string {
  if (!SENSITIVE_HEADER.test(name)) return value
  const scheme = /^(Bearer|Basic|Digest|Token)\s+/i.exec(value)?.[0] ?? ''
  return `${scheme}${maskSecret(value.slice(scheme.length))}`
}

const maskSecret = (secret: string): string => (secret.length > 8 ? `••••${secret.slice(-4)}` : '••••')

/** Query parameters that usually carry a credential (`api_key`, `access_token`, `sig`, …). */
export const SENSITIVE_PARAM =
  /(^|[_.-])(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|signature|sig|auth|key|credentials?)$/i

/**
 * A sent URL with its secrets hidden: the password of `user:pass@host` and the
 * values of query parameters named like credentials. History keeps this form, so
 * an API key that was passed in the query doesn't end up in history.json.
 */
export function maskUrlSecrets(url: string): string {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@]*?):([^/?#@]*)@/i, (_m, user: string) => `${user}:••••@`)
  const q = out.indexOf('?')
  if (q < 0) return out
  const hash = out.indexOf('#', q)
  const query = out.slice(q + 1, hash < 0 ? undefined : hash)
  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      const name = pair.slice(0, eq)
      let decoded = name
      try {
        decoded = decodeURIComponent(name)
      } catch {
        // Keep the raw name.
      }
      return SENSITIVE_PARAM.test(decoded) ? `${name}=${maskSecret(pair.slice(eq + 1))}` : pair
    })
    .join('&')
  out = out.slice(0, q + 1) + masked + (hash < 0 ? '' : out.slice(hash))
  return out
}

const MAX_BODY = 200_000

function bodyText(res: HttpResponse): { text: string; truncated: boolean; binary: boolean } {
  const ct = getHeader(res.headers, 'content-type') ?? ''
  if (/^(image|audio|video)\/|octet-stream|pdf|zip/.test(ct)) return { text: `[${res.body.length} bytes of ${ct || 'binary data'}]`, truncated: false, binary: true }
  let text = decodeBody(res.body, res.headers)
  if (/json/.test(ct) || /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Not JSON after all: keep as received.
    }
  }
  return text.length > MAX_BODY ? { text: text.slice(0, MAX_BODY), truncated: true, binary: false } : { text, truncated: false, binary: false }
}

export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // Spreadsheets run text starting with = + - @ (or a tab/CR before one) as a formula.
  // Values come from responses, so such text gets a leading ' unless it's just a number.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const ms = (n?: number): string => (n === undefined ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`)
const size = (n?: number): string => (n === undefined ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`)
const when = (t: number): string => new Date(t).toLocaleString()
/** A Markdown code fence longer than any backtick run in the content. */
const fence = (s: string): string => '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)))
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const PRINT_CSS = `
  body { font: 12px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1e28; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #dfe3ea; padding-bottom: 4px; }
  .meta { color: #5b6375; margin-bottom: 14px; } .brand { color: #0e7490; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e8ebf1; vertical-align: top; }
  th { background: #f3f4f7; font-weight: 600; } td.mono, pre, code { font-family: "JetBrains Mono", Menlo, Consolas, monospace; font-size: 11px; }
  pre { background: #f6f7fa; border: 1px solid #e1e4eb; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }
  .ok { color: #12915a; font-weight: 600; } .bad { color: #d23a52; font-weight: 600; } .muted { color: #8d94a5; }
  .cards { display: flex; gap: 10px; margin: 8px 0 4px; } .card { flex: 1; border: 1px solid #e1e4eb; border-radius: 8px; padding: 8px 10px; }
  .card b { display: block; font-size: 17px; } tr { page-break-inside: avoid; }
  /* Fixed layout: one huge header value must not squeeze the names column. */
  table.headers { table-layout: fixed; } table.headers th:first-child { width: 32%; }
  table.headers td:first-child { font-weight: 600; overflow-wrap: anywhere; } table.headers td + td { word-break: break-all; }`

// Every value in the body is escaped; the policy is a second line of defence, so a
// report can never load a remote image, frame a local file or run a script when
// it is rendered to PDF or opened in a browser.
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const htmlPage = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`

// --- A single response --------------------------------------------------------------

export interface ResultReportInput {
  name: string
  at: number
  request: PreparedRequest
  response?: HttpResponse
  error?: string
  tests: TestResult[]
  logs: LogEntry[]
}

export function resultReport(r: ResultReportInput, format: Exclude<ReportFormat, 'pdf'> | 'html', tool = 'FlosForge Caller'): string {
  const res = r.response
  const body = res ? bodyText(res) : undefined
  // The headers actually sent (the engine adds User-Agent, Accept, cookies…), when we have them.
  const sentHeaders = res?.requestHeaders.length ? res.requestHeaders : r.request.headers
  const reqHeaders = sentHeaders.map(([k, v]) => [k, maskHeader(k, v)] as const)
  const resHeaders = (res?.headers ?? []).map(([k, v]) => [k, maskHeader(k, v)] as const)
  const passed = r.tests.filter((t) => t.passed && !t.skipped).length
  const counted = r.tests.filter((t) => !t.skipped).length
  const status = res ? `${res.status} ${res.statusText}` : (r.error ?? 'no response')

  switch (format) {
    case 'json':
      return JSON.stringify(
        {
          tool,
          name: r.name,
          at: new Date(r.at).toISOString(),
          request: { method: r.request.method, url: r.request.url, headers: reqHeaders },
          response: res && {
            status: res.status,
            statusText: res.statusText,
            timeMs: Math.round(res.timings.total),
            sizeBytes: res.bodySize,
            headers: resHeaders,
            body: body?.binary ? undefined : body?.text
          },
          error: r.error,
          tests: r.tests,
          logs: r.logs
        },
        null,
        2
      )

    case 'csv': {
      // A JSON list of objects is most useful as the table itself.
      if (res && !body?.binary) {
        try {
          const data = JSON.parse(decodeBody(res.body, res.headers))
          const rows = Array.isArray(data) ? data : null
          if (rows?.length && rows.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
            const cols = [...new Set(rows.flatMap((x) => Object.keys(x)))]
            return toCsv([cols, ...rows.map((x) => cols.map((c) => (x as Record<string, unknown>)[c]))])
          }
        } catch {
          // Not JSON: fall through to the summary.
        }
      }
      return toCsv([
        ['field', 'value'],
        ['request', r.name],
        ['method', r.request.method],
        ['url', r.request.url],
        ['status', status],
        ['time_ms', res ? Math.round(res.timings.total) : ''],
        ['size_bytes', res?.bodySize ?? ''],
        ...r.tests.map((t) => [`test: ${t.name}`, t.skipped ? 'skipped' : t.passed ? 'passed' : `failed: ${t.error ?? ''}`])
      ])
    }

    case 'md': {
      const lines = [
        `# ${r.name}`,
        '',
        `**${r.request.method}** \`${r.request.url}\`  `,
        `Status **${status}** · ${ms(res?.timings.total)} · ${size(res?.bodySize)} · ${when(r.at)}`,
        ''
      ]
      if (r.error) lines.push(`> **Error:** ${r.error}`, '')
      if (r.tests.length) {
        lines.push(`## Tests (${passed}/${counted} passed)`, '')
        for (const t of r.tests) lines.push(`- ${t.skipped ? '○' : t.passed ? '✅' : '❌'} ${t.name}${t.error ? ` — ${t.error}` : ''}`)
        lines.push('')
      }
      const table = (rows: readonly (readonly [string, string])[]): string[] =>
        rows.length ? ['| Header | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${mdCell(k)} | ${mdCell(v)} |`), ''] : ['_None_', '']
      lines.push('## Request headers', '', ...table(reqHeaders))
      if (res) {
        lines.push('## Response headers', '', ...table(resHeaders))
        const f = fence(body!.text)
        lines.push('## Response body', '', `${f}${/json/.test(getHeader(res.headers, 'content-type') ?? '') ? 'json' : ''}`, body!.text, f, '')
        if (body!.truncated) lines.push(`_Truncated to the first ${MAX_BODY.toLocaleString()} characters._`, '')
      }
      if (r.logs.length) lines.push('## Logs', '', ...r.logs.map((l) => `- \`${l.level}\` ${mdCell(l.message)}`), '')
      lines.push(`_Exported from ${tool}. Sensitive headers are masked._`, '')
      return lines.join('\n')
    }

    case 'txt': {
      const lines = [
        r.name,
        '='.repeat(Math.min(80, r.name.length)),
        `${r.request.method} ${r.request.url}`,
        `Status: ${status}   Time: ${ms(res?.timings.total)}   Size: ${size(res?.bodySize)}   At: ${when(r.at)}`,
        ''
      ]
      if (r.error) lines.push(`ERROR: ${r.error}`, '')
      if (r.tests.length) {
        lines.push(`Tests: ${passed}/${counted} passed`)
        for (const t of r.tests) lines.push(`  [${t.skipped ? 'skip' : t.passed ? 'pass' : 'FAIL'}] ${t.name}${t.error ? ` - ${t.error}` : ''}`)
        lines.push('')
      }
      lines.push('Request headers:', ...reqHeaders.map(([k, v]) => `  ${k}: ${v}`), '')
      if (res) {
        lines.push('Response headers:', ...resHeaders.map(([k, v]) => `  ${k}: ${v}`), '', 'Response body:', body!.text)
        if (body!.truncated) lines.push('', `(truncated to the first ${MAX_BODY.toLocaleString()} characters)`)
        lines.push('')
      }
      if (r.logs.length) lines.push('Logs:', ...r.logs.map((l) => `  [${l.level}] ${l.message}`), '')
      return lines.join('\n')
    }

    case 'html': {
      const headerTable = (rows: readonly (readonly [string, string])[]): string =>
        rows.length
          ? `<table class="headers"><tr><th>Header</th><th>Value</th></tr>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</table>`
          : '<p class="muted">None</p>'
      const tone = res ? (res.status < 400 ? 'ok' : 'bad') : 'bad'
      return htmlPage(
        r.name,
        `<h1>${esc(r.name)}</h1>
        <div class="meta"><span class="brand">${esc(tool)}</span> · ${esc(when(r.at))}</div>
        <p><b>${esc(r.request.method)}</b> <code>${esc(r.request.url)}</code></p>
        <div class="cards"><div class="card"><b class="${tone}">${esc(status)}</b>status</div><div class="card"><b>${ms(res?.timings.total)}</b>time</div><div class="card"><b>${size(res?.bodySize)}</b>size</div>${counted ? `<div class="card"><b class="${passed === counted ? 'ok' : 'bad'}">${passed}/${counted}</b>tests passed</div>` : ''}</div>
        ${r.error ? `<p class="bad">${esc(r.error)}</p>` : ''}
        ${r.tests.length ? `<h2>Tests</h2><table>${r.tests.map((t) => `<tr><td class="${t.skipped ? 'muted' : t.passed ? 'ok' : 'bad'}">${t.skipped ? 'skipped' : t.passed ? 'passed' : 'failed'}</td><td>${esc(t.name)}${t.error ? `<br><span class="bad">${esc(t.error)}</span>` : ''}</td></tr>`).join('')}</table>` : ''}
        <h2>Request headers</h2>${headerTable(reqHeaders)}
        ${res ? `<h2>Response headers</h2>${headerTable(resHeaders)}<h2>Response body</h2><pre>${esc(body!.text)}</pre>${body!.truncated ? '<p class="muted">Truncated.</p>' : ''}` : ''}
        ${r.logs.length ? `<h2>Logs</h2><pre>${esc(r.logs.map((l) => `[${l.level}] ${l.message}`).join('\n'))}</pre>` : ''}
        <p class="muted">Sensitive headers are masked.</p>`
      )
    }
  }
}

// --- A collection run ---------------------------------------------------------------------

export function runReport(
  name: string,
  summary: RunSummary,
  steps: RunStep[],
  format: Exclude<ReportFormat, 'pdf' | 'json'> | 'html',
  tool = 'FlosForge Caller'
): string {
  const multi = summary.totalIterations > 1
  const totalTests = summary.tests.passed + summary.tests.failed
  const duration = ms(summary.finishedAt - summary.startedAt)
  const testsOf = (s: RunStep): string => {
    const counted = s.tests.filter((t) => !t.skipped)
    return counted.length ? `${counted.filter((t) => t.passed).length}/${counted.length}` : '—'
  }
  const problem = (s: RunStep): string =>
    s.error ?? s.scriptErrors[0] ?? s.tests.filter((t) => !t.passed && !t.skipped).map((t) => `${t.name}: ${t.error ?? 'failed'}`).join('; ')

  switch (format) {
    case 'csv':
      return toCsv([
        ['iteration', 'request', 'method', 'url', 'status', 'time_ms', 'size_bytes', 'tests_passed', 'tests_failed', 'result', 'problem'],
        ...steps.map((s) => [
          s.iteration + 1,
          s.name,
          s.method,
          s.url,
          s.status ?? '',
          s.timeMs ?? '',
          s.sizeBytes ?? '',
          s.tests.filter((t) => t.passed && !t.skipped).length,
          s.tests.filter((t) => !t.passed && !t.skipped).length,
          s.skipped ? 'skipped' : s.passed ? 'passed' : 'failed',
          s.passed ? '' : problem(s)
        ])
      ])

    case 'md': {
      const lines = [
        `# Run: ${name}`,
        '',
        `${when(summary.startedAt)} · ${duration} · ${summary.iterations} iteration${summary.iterations > 1 ? 's' : ''}`,
        '',
        '| | Executed | Failed |',
        '| --- | ---: | ---: |',
        `| Requests | ${summary.requests} | ${summary.failedRequests} |`,
        `| Tests | ${totalTests} | ${summary.tests.failed} |`,
        '',
        `Average response: ${ms(summary.avgResponseMs)}`,
        ''
      ]
      if (summary.note) lines.push(`> ${summary.note}`, '')
      lines.push(
        `| ${multi ? 'Iteration | ' : ''}Request | Status | Time | Tests | Result |`,
        `| ${multi ? '---: | ' : ''}--- | --- | ---: | ---: | --- |`,
        ...steps.map(
          (s) =>
            `| ${multi ? `${s.iteration + 1} | ` : ''}${s.method} ${mdCell(s.name)} | ${s.status ?? '—'} | ${ms(s.timeMs)} | ${testsOf(s)} | ${s.skipped ? 'skipped' : s.passed ? '✅' : '❌'} |`
        ),
        ''
      )
      const failed = steps.filter((s) => !s.passed)
      if (failed.length) {
        lines.push('## Failures', '')
        failed.forEach((s, i) => lines.push(`${i + 1}. **${mdCell(s.name)}**${multi ? ` (iteration ${s.iteration + 1})` : ''}: ${mdCell(problem(s))}`))
        lines.push('')
      }
      lines.push(`_Exported from ${tool}._`, '')
      return lines.join('\n')
    }

    case 'txt': {
      const lines = [
        `Run: ${name}`,
        `${when(summary.startedAt)}   Duration: ${duration}   Iterations: ${summary.iterations}`,
        `Requests: ${summary.requests} (${summary.failedRequests} failed)   Tests: ${totalTests} (${summary.tests.failed} failed)   Avg response: ${ms(summary.avgResponseMs)}`,
        ''
      ]
      if (summary.note) lines.push(summary.note, '')
      let it = -1
      for (const s of steps) {
        if (multi && s.iteration !== it) {
          it = s.iteration
          lines.push(`Iteration ${it + 1}`)
        }
        lines.push(`  [${s.skipped ? 'skip' : s.passed ? 'pass' : 'FAIL'}] ${s.method.padEnd(6)} ${s.name}  ${s.status ?? '-'}  ${ms(s.timeMs)}  tests ${testsOf(s)}`)
        if (!s.passed && !s.skipped) lines.push(`         ${problem(s)}`)
      }
      lines.push('')
      return lines.join('\n')
    }

    case 'html':
      return htmlPage(
        `Run: ${name}`,
        `<h1>Run: ${esc(name)}</h1>
        <div class="meta"><span class="brand">${esc(tool)}</span> · ${esc(when(summary.startedAt))} · ${duration}</div>
        <div class="cards"><div class="card"><b class="${summary.failedRequests ? 'bad' : 'ok'}">${summary.requests - summary.failedRequests}/${summary.requests}</b>requests passed</div><div class="card"><b class="${summary.tests.failed ? 'bad' : 'ok'}">${summary.tests.passed}/${totalTests}</b>tests passed</div><div class="card"><b>${ms(summary.avgResponseMs)}</b>average response</div><div class="card"><b>${summary.iterations}</b>iteration${summary.iterations > 1 ? 's' : ''}</div></div>
        ${summary.note ? `<p class="bad">${esc(summary.note)}</p>` : ''}
        <h2>Requests</h2>
        <table><tr>${multi ? '<th>#</th>' : ''}<th>Request</th><th>Status</th><th>Time</th><th>Tests</th><th>Result</th></tr>
        ${steps
          .map(
            (s) =>
              `<tr>${multi ? `<td>${s.iteration + 1}</td>` : ''}<td><b>${esc(s.method)}</b> ${esc(s.name)}${!s.passed && !s.skipped ? `<br><span class="bad">${esc(problem(s))}</span>` : ''}</td><td>${s.status ?? '—'}</td><td>${ms(s.timeMs)}</td><td>${testsOf(s)}</td><td class="${s.skipped ? 'muted' : s.passed ? 'ok' : 'bad'}">${s.skipped ? 'skipped' : s.passed ? 'passed' : 'failed'}</td></tr>`
          )
          .join('')}</table>`
      )
  }
}
