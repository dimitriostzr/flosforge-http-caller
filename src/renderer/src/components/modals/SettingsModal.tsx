import { useEffect, useState } from 'react'
import { Compass, FolderOpen, Download, Globe, Info, Palette, Send, Database, Layers, Plus, Settings2, ShieldCheck } from 'lucide-react'
import type { Settings } from '@shared/types'
import { useWorkspace } from '../../store/workspace'
import { useDialogs } from '../../store/dialogs'
import { exportEverything, openDemoWorkspace, switchWorkspace } from '../../lib/actions'
import { Modal, Toggle } from '../ui'
import { AppearanceSettings } from '../settings/AppearanceSettings'
import { AboutSettings } from '../settings/AboutSettings'
import { CertificateSettingsPane, ProxySettingsPane } from '../settings/NetworkSettings'
import { workspaceFill } from '../sidebar/WorkspaceSwitcher'

type Section = 'appearance' | 'requests' | 'proxy' | 'certificates' | 'workspaces' | 'data' | 'about'
const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'requests', label: 'Requests', icon: <Send size={15} /> },
  { id: 'proxy', label: 'Proxy', icon: <Globe size={15} /> },
  { id: 'certificates', label: 'Certificates', icon: <ShieldCheck size={15} /> },
  { id: 'workspaces', label: 'Workspaces', icon: <Layers size={15} /> },
  { id: 'data', label: 'Data', icon: <Database size={15} /> },
  { id: 'about', label: 'About & licenses', icon: <Info size={15} /> }
]
let lastSection: Section = 'appearance'

export function SettingsModal({ section: initial }: { section?: Section }) {
  const close = useDialogs((s) => s.closeModal)
  const settings = useWorkspace((s) => s.settings)
  const update = useWorkspace((s) => s.updateSettings)
  const [section, setSectionState] = useState<Section>(initial ?? lastSection)
  const setSection = (s: Section) => {
    lastSection = s
    setSectionState(s)
  }
  const [info, setInfo] = useState<{ version: string; dataDir: string; platform: string } | null>(null)
  useEffect(() => {
    void window.api.info().then(setInfo)
  }, [])
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update({ [k]: v } as Partial<Settings>)

  return (
    <Modal title="Settings" onClose={close} width={940} className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
              {s.icon} {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {section === 'appearance' && <AppearanceSettings />}
          {section === 'requests' && (
            <div className="settings-grid">
              <section>
                <h4>Requests</h4>
                <div className="setting-row">
                  <span>Response panel</span>
                  <div className="seg">
                    <button className={settings.layout === 'stacked' ? 'active' : ''} onClick={() => set('layout', 'stacked')}>
                      Below
                    </button>
                    <button className={settings.layout === 'side' ? 'active' : ''} onClick={() => set('layout', 'side')}>
                      Beside
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <span>
                    Timeout <span className="muted small">(ms, 0 = none)</span>
                  </span>
                  <input
                    className="text-input num"
                    type="number"
                    min={0}
                    step={1000}
                    value={settings.timeoutMs}
                    onChange={(e) => set('timeoutMs', Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="setting-row">
                  <span>Follow redirects</span>
                  <Toggle checked={settings.followRedirects} onChange={(v) => set('followRedirects', v)} />
                </div>
                <div className="setting-row">
                  <span>Max redirects</span>
                  <input
                    className="text-input num"
                    type="number"
                    min={0}
                    max={50}
                    value={settings.maxRedirects}
                    onChange={(e) => set('maxRedirects', Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="setting-row">
                  <span>Cookie jar (store & send cookies automatically)</span>
                  <Toggle checked={settings.useCookieJar} onChange={(v) => set('useCookieJar', v)} />
                </div>
                <div className="setting-row">
                  <span>Ask for missing {'{{variables}}'} when sending</span>
                  <Toggle checked={settings.askForMissingVariables} onChange={(v) => set('askForMissingVariables', v)} />
                </div>
                <div className="setting-row">
                  <span>
                    Script time limit <span className="muted small">(ms)</span>
                  </span>
                  <input
                    className="text-input num"
                    type="number"
                    min={500}
                    step={500}
                    value={settings.scriptTimeoutMs}
                    onChange={(e) => set('scriptTimeoutMs', Math.max(500, Number(e.target.value) || 5000))}
                  />
                </div>
                <div className="setting-row">
                  <span>History entries to keep</span>
                  <input
                    className="text-input num"
                    type="number"
                    min={0}
                    max={5000}
                    value={settings.historyLimit}
                    onChange={(e) => set('historyLimit', Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
              </section>

            </div>
          )}
          {section === 'proxy' && <ProxySettingsPane />}
          {section === 'certificates' && <CertificateSettingsPane />}
          {section === 'workspaces' && <WorkspacesSettings />}
          {section === 'data' && (
            <div className="settings-grid">
              <section>
                <h4>Data</h4>
                <p className="hint">
                  Everything is stored locally as plain JSON — no account, no cloud.
                  {info && (
                    <>
                      {' '}
                      Location: <code className="path">{info.dataDir}</code>
                    </>
                  )}
                </p>
                <div className="row-gap">
                  <button className="btn secondary small" onClick={() => void window.api.openDataDir()}>
                    <FolderOpen size={14} /> Open data folder
                  </button>
                  <button className="btn secondary small" onClick={() => void exportEverything()}>
                    <Download size={14} /> Export backup
                  </button>
                </div>
              </section>
            </div>
          )}
          {section === 'about' && <AboutSettings version={info?.version} />}
        </div>
      </div>
    </Modal>
  )
}

function WorkspacesSettings() {
  const workspaces = useWorkspace((s) => s.workspaces)
  const activeId = useWorkspace((s) => s.activeWorkspaceId)
  const openModal = useDialogs((s) => s.openModal)
  return (
    <div className="settings-grid">
      <section>
        <h4>Workspaces</h4>
        <p className="hint">
          Each workspace keeps its own collections, environments, globals, history and open tabs, and can have its own
          accent colour. Settings and the cookie jar are shared.
        </p>
        <div className="ws-list">
          {workspaces.map((w) => (
            <div key={w.id} className={`ws-list-row ${w.id === activeId ? 'active' : ''}`}>
              <span className="ws-dot large" style={{ background: workspaceFill(w.color) }} />
              <span className="ws-list-name">{w.name}</span>
              <span className="muted small">{w.color ? w.color : 'Theme accent'}</span>
              {w.id === activeId ? (
                <span className="ws-current small">Open</span>
              ) : (
                <button className="btn ghost small" onClick={() => void switchWorkspace(w.id)}>
                  Open
                </button>
              )}
              <button className="icon-btn" title="Edit" onClick={() => openModal('workspace', { id: w.id })}>
                <Settings2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button className="btn secondary small" onClick={() => openModal('workspace')}>
            <Plus size={14} /> New workspace
          </button>
          <button className="btn ghost small" onClick={() => void openDemoWorkspace()}>
            <Compass size={14} /> Open the demo workspace
          </button>
        </div>
      </section>
    </div>
  )
}
