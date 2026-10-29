import { FilePlus2, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { uid } from '@shared/model'
import type { CertificateSettings, ClientCertificate, ProxySettings } from '@shared/types'
import { useWorkspace } from '../../store/workspace'
import { Toggle } from '../ui'

const MODES: { id: ProxySettings['mode']; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Uses your operating system’s proxy settings, including automatic configuration (PAC) scripts.' },
  { id: 'custom', label: 'Custom', hint: 'Sends every request through the proxy below, except for the hosts you list.' },
  { id: 'off', label: 'Off', hint: 'Every request connects directly, whatever the system settings say.' }
]

export function ProxySettingsPane() {
  const proxy = useWorkspace((s) => s.settings.proxy)
  const update = useWorkspace((s) => s.updateSettings)
  const set = (patch: Partial<ProxySettings>) => update({ proxy: { ...proxy, ...patch } })
  const mode = MODES.find((m) => m.id === proxy.mode) ?? MODES[0]

  return (
    <div className="settings-grid">
      <section>
        <h4>Proxy</h4>
        <div className="setting-row">
          <span>Connect through</span>
          <div className="seg">
            {MODES.map((m) => (
              <button key={m.id} className={proxy.mode === m.id ? 'active' : ''} onClick={() => set({ mode: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">{mode.hint}</p>
      </section>

      {proxy.mode === 'custom' && (
        <section>
          <h4>Custom proxy</h4>
          <div className="setting-row">
            <span>Address</span>
            <input
              className="text-input wide"
              value={proxy.url}
              placeholder="http://proxy.example.com:3128"
              spellCheck={false}
              onChange={(e) => set({ url: e.target.value })}
            />
          </div>
          <div className="setting-row">
            <span>
              Username <span className="muted small">(optional)</span>
            </span>
            <input className="text-input wide" value={proxy.username} spellCheck={false} onChange={(e) => set({ username: e.target.value })} />
          </div>
          <div className="setting-row">
            <span>
              Password <span className="muted small">(optional)</span>
            </span>
            <input className="text-input wide" type="password" value={proxy.password} onChange={(e) => set({ password: e.target.value })} />
          </div>
          <div className="setting-row">
            <span>Don’t use the proxy for</span>
            <input
              className="text-input wide"
              value={proxy.bypass}
              placeholder="localhost, 127.0.0.1, .internal.example.com"
              spellCheck={false}
              onChange={(e) => set({ bypass: e.target.value })}
            />
          </div>
          <p className="hint">
            HTTP proxies (https goes through a CONNECT tunnel) and SOCKS 4, 4a, 5 and 5h, for example{' '}
            <code>socks5h://127.0.0.1:1080</code>. In the exceptions, <code>example.com</code> also covers its subdomains;
            ranges like <code>10.0.0.0/8</code> and <code>*</code> (everything) work too. The password is saved in this
            computer’s settings file.
          </p>
        </section>
      )}
    </div>
  )
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

function FileField({ label, path, onChange }: { label: string; path: string; onChange: (path: string) => void }) {
  return (
    <div className="cert-file">
      <span className="cert-file-label">{label}</span>
      <span className={`cert-file-path ${path ? '' : 'muted'}`} title={path}>
        {path ? fileName(path) : 'None'}
      </span>
      <button
        className="btn ghost small"
        onClick={async () => {
          const [picked] = await window.api.pickFiles(false)
          if (picked) onChange(picked)
        }}
      >
        <FolderOpen size={13} /> Choose…
      </button>
      {path && (
        <button className="icon-btn subtle" title="Clear" onClick={() => onChange('')}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

export function CertificateSettingsPane() {
  const certs = useWorkspace((s) => s.settings.certificates)
  const verifySsl = useWorkspace((s) => s.settings.verifySsl)
  const update = useWorkspace((s) => s.updateSettings)
  const set = (patch: Partial<CertificateSettings>) => update({ certificates: { ...certs, ...patch } })
  const setClient = (id: string, patch: Partial<ClientCertificate>) =>
    set({ client: certs.client.map((c) => (c.id === id ? { ...c, ...patch } : c)) })

  return (
    <div className="settings-grid">
      <section>
        <h4>Server certificates</h4>
        <div className="setting-row">
          <span>
            Verify SSL certificates
            {!verifySsl && <span className="warn-text small"> (off: any certificate is accepted)</span>}
          </span>
          <Toggle checked={verifySsl} onChange={(v) => update({ verifySsl: v })} />
        </div>
        <div className="setting-row">
          <span>Also trust the certificates installed in the operating system</span>
          <Toggle checked={certs.useSystemCa} onChange={(v) => set({ useSystemCa: v })} />
        </div>
        <p className="hint">
          Turn this on when your company network checks https traffic with its own root certificate, or add that
          certificate below. Extra CA certificates are trusted on top of the built-in list (PEM or DER files).
        </p>
        {certs.caPaths.length > 0 && (
          <div className="ws-list cert-list">
            {certs.caPaths.map((p, i) => (
              <div key={`${p}-${i}`} className="ws-list-row">
                <span className="ws-list-name path" title={p}>
                  {fileName(p)}
                </span>
                <span className="muted small path cert-dir">{p}</span>
                <button className="icon-btn subtle" title="Remove" onClick={() => set({ caPaths: certs.caPaths.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="btn secondary small"
            onClick={async () => {
              const picked = await window.api.pickFiles(true)
              if (picked.length) set({ caPaths: [...certs.caPaths, ...picked.filter((p) => !certs.caPaths.includes(p))] })
            }}
          >
            <FilePlus2 size={14} /> Add CA certificate…
          </button>
        </div>
      </section>

      <section>
        <h4>Client certificates</h4>
        <p className="hint">
          For servers that ask who you are (mutual TLS). Each certificate is sent only to the hosts it’s for:{' '}
          <code>api.example.com</code>, <code>*.example.com</code> or <code>localhost:8443</code>. Use a PEM certificate
          and key, or a PKCS#12 file (.pfx, .p12).
        </p>
        <div className="cert-cards">
          {certs.client.map((c) => (
            <div key={c.id} className={`cert-card ${c.enabled ? '' : 'disabled'}`}>
              <div className="cert-card-head">
                <Toggle checked={c.enabled} onChange={(v) => setClient(c.id, { enabled: v })} />
                <input
                  className="text-input"
                  value={c.host}
                  placeholder="Host, e.g. api.example.com"
                  spellCheck={false}
                  onChange={(e) => setClient(c.id, { host: e.target.value })}
                />
                <button
                  className="icon-btn subtle"
                  title="Remove"
                  onClick={() => set({ client: certs.client.filter((x) => x.id !== c.id) })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <FileField label="Certificate" path={c.certPath} onChange={(certPath) => setClient(c.id, { certPath, ...(certPath ? { pfxPath: '' } : {}) })} />
              <FileField label="Key" path={c.keyPath} onChange={(keyPath) => setClient(c.id, { keyPath, ...(keyPath ? { pfxPath: '' } : {}) })} />
              <FileField
                label="or PKCS#12"
                path={c.pfxPath}
                onChange={(pfxPath) => setClient(c.id, { pfxPath, ...(pfxPath ? { certPath: '', keyPath: '' } : {}) })}
              />
              <div className="cert-file">
                <span className="cert-file-label">Passphrase</span>
                <input
                  className="text-input"
                  type="password"
                  value={c.passphrase}
                  placeholder="Only if the key is encrypted"
                  onChange={(e) => setClient(c.id, { passphrase: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="btn secondary small"
            onClick={() =>
              set({
                client: [
                  ...certs.client,
                  { id: uid(), enabled: true, host: '', certPath: '', keyPath: '', pfxPath: '', passphrase: '' }
                ]
              })
            }
          >
            <Plus size={14} /> Add client certificate
          </button>
        </div>
        <p className="hint">Certificate files stay where they are; passphrases are saved in this computer’s settings file.</p>
      </section>
    </div>
  )
}
