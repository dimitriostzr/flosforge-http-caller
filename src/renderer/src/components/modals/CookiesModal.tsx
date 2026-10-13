import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { CookieInfo } from '@shared/types'
import { confirm, toast, useDialogs } from '../../store/dialogs'
import { Empty, Modal } from '../ui'

export function CookiesModal() {
  const close = useDialogs((s) => s.closeModal)
  const [cookies, setCookies] = useState<CookieInfo[]>([])
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('https://')
  const [raw, setRaw] = useState('')

  const refresh = useCallback(() => void window.api.cookies.list().then(setCookies), [])
  useEffect(refresh, [refresh])

  const byDomain = useMemo(() => {
    const m = new Map<string, CookieInfo[]>()
    for (const c of cookies) {
      if (filter && !c.domain.includes(filter) && !c.key.includes(filter)) continue
      if (!m.has(c.domain)) m.set(c.domain, [])
      m.get(c.domain)!.push(c)
    }
    return [...m.entries()]
  }, [cookies, filter])

  const add = async () => {
    try {
      await window.api.cookies.set(url, raw)
      setRaw('')
      setAdding(false)
      refresh()
    } catch (e) {
      toast(`Could not add cookie: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': /, '')}`, 'error')
    }
  }

  return (
    <Modal title="Cookie jar" onClose={close} width={720}>
      <div className="cookies-bar">
        <input className="text-input" placeholder="Filter by domain or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn secondary small" onClick={() => setAdding(!adding)}>
          <Plus size={14} /> Add
        </button>
        <button
          className="btn ghost small danger-text"
          disabled={!cookies.length}
          onClick={async () => {
            const ok = await confirm({ title: 'Clear all cookies?', message: 'Every stored cookie will be removed.', confirmLabel: 'Clear', danger: true })
            if (ok === true) {
              await window.api.cookies.clear()
              refresh()
            }
          }}
        >
          Clear all
        </button>
      </div>
      {adding && (
        <div className="cookie-add">
          <input className="text-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
          <input
            className="text-input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="session=abc123; Path=/; HttpOnly"
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="btn primary small" onClick={() => void add()} disabled={!raw.trim()}>
            Save
          </button>
        </div>
      )}
      <div className="cookie-list">
        {byDomain.length === 0 && <Empty title="No cookies">Cookies set by responses are stored here and sent on matching requests.</Empty>}
        {byDomain.map(([domain, list]) => (
          <div key={domain} className="cookie-domain">
            <div className="cookie-domain-head">
              <span>{domain}</span>
              <button
                className="icon-btn subtle"
                title={`Remove all cookies for ${domain}`}
                onClick={async () => {
                  await window.api.cookies.removeDomain(domain)
                  refresh()
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <table className="data-table compact">
              <tbody>
                {list.map((c) => (
                  <tr key={`${c.path}|${c.key}`}>
                    <td className="data-key">{c.key}</td>
                    <td className="data-value">{c.value}</td>
                    <td className="muted small nowrap">
                      {c.path}
                      {c.secure ? ' · Secure' : ''}
                      {c.httpOnly ? ' · HttpOnly' : ''}
                      {c.expires ? ` · until ${new Date(c.expires).toLocaleString()}` : ' · session'}
                    </td>
                    <td className="nowrap">
                      <button
                        className="icon-btn subtle"
                        onClick={async () => {
                          await window.api.cookies.remove(c.domain, c.path, c.key)
                          refresh()
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  )
}
