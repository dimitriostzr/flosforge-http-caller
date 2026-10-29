import { useEffect } from 'react'
import { Compass, FilePlus2, Import, Library } from 'lucide-react'
import { APP_NAME } from '@shared/app'
import { activeTab, useWorkspace } from './store/workspace'
import { useDialogs } from './store/dialogs'
import { useRuntime } from './store/runtime'
import { startPersistence } from './store/persist'
import { sendTab } from './lib/runner'
import { closeTab, createCollection, openDemoWorkspace, saveActiveTab } from './lib/actions'
import { useThemeEffect } from './theme/useTheme'
import { Rail, Sidebar, LogoMark } from './components/sidebar/Sidebar'
import { TabBar } from './components/TabBar'
import { RequestView } from './components/request/RequestView'
import { EnvironmentView, GlobalsView, ItemSettingsView } from './components/ItemSettingsView'
import { DialogHost } from './components/modals/DialogHost'
import { ContextMenuHost, modKey } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TitleBar } from './components/TitleBar'
import { RunnerView } from './components/runner/RunnerView'
import { VariablesOverview } from './components/variables/VariablesOverview'
import { FlowView } from './components/flows/FlowView'

let booted = false

function useBoot(): void {
  useEffect(() => {
    if (booted) return
    booted = true
    void window.api.boot().then((boot) => {
      useWorkspace.getState().hydrate(boot)
      startPersistence()
    })
  }, [])
}

/** Responses arriving for tabs' requests, shown live in the response panel. */
function useHttpProgress(): void {
  useEffect(() => window.api.onHttpProgress((execId, p) => useRuntime.getState().applyProgress(execId, p)), [])
}

function useMenuCommands(): void {
  useEffect(
    () =>
      window.api.onMenu((cmd) => {
        const ws = useWorkspace.getState()
        const dialogs = useDialogs.getState()
        const tab = activeTab(ws)
        switch (cmd) {
          case 'new-request':
            return ws.openScratch()
          case 'new-collection':
            return void createCollection()
          case 'new-workspace':
            return dialogs.openModal('workspace')
          case 'import':
            return dialogs.openModal('import')
          case 'settings':
            return dialogs.openModal('settings')
          case 'save':
            return saveActiveTab()
          case 'close-tab':
            return tab && void closeTab(tab.id)
          case 'send':
            return tab?.kind === 'request' && void sendTab(tab.id)
          case 'toggle-sidebar':
            return ws.toggleSidebar()
          case 'toggle-layout':
            return ws.updateSettings({ layout: ws.settings.layout === 'side' ? 'stacked' : 'side' })
          case 'next-tab':
            return ws.cycleTab(1)
          case 'prev-tab':
            return ws.cycleTab(-1)
        }
      }),
    []
  )
}

export function App() {
  useBoot()
  useThemeEffect()
  useMenuCommands()
  useHttpProgress()
  const loaded = useWorkspace((s) => s.loaded)
  const sidebarVisible = useWorkspace((s) => s.sidebarVisible)
  const tab = useWorkspace(activeTab)

  if (!loaded) return <div className="boot" />

  return (
    <div className="app-shell">
    <TitleBar />
    <div className="app">
      <Rail />
      {sidebarVisible && (
        <ErrorBoundary area="the sidebar">
          <Sidebar />
        </ErrorBoundary>
      )}
      <main className="main">
        <TabBar />
        <div className="workspace">
          {/* Keyed by tab so switching tabs clears a crash in the previous one. */}
          <ErrorBoundary key={tab?.id ?? 'welcome'} area="this tab">
            {!tab && <Welcome />}
            {tab?.kind === 'request' && <RequestView key={tab.id} tab={tab} />}
            {(tab?.kind === 'collection' || tab?.kind === 'folder') && <ItemSettingsView key={tab.id} tab={tab} />}
            {tab?.kind === 'environment' && <EnvironmentView key={tab.id} tab={tab} />}
            {tab?.kind === 'globals' && <GlobalsView key={tab.id} />}
            {tab?.kind === 'variables' && <VariablesOverview key={tab.id} />}
            {tab?.kind === 'flow' && <FlowView key={tab.id} tab={tab} />}
            {tab?.kind === 'runner' && <RunnerView key={tab.id} tab={tab} />}
          </ErrorBoundary>
        </div>
      </main>
      <ErrorBoundary area="a dialog">
        <DialogHost />
      </ErrorBoundary>
      <ContextMenuHost />
    </div>
    </div>
  )
}

function Welcome() {
  const openScratch = useWorkspace((s) => s.openScratch)
  const openModal = useDialogs((s) => s.openModal)
  return (
    <div className="welcome">
      <LogoMark size={64} />
      <h1>{APP_NAME}</h1>
      <p className="muted">A local-first API client from FlosForge. No account, no cloud, no telemetry.</p>
      <div className="welcome-actions">
        <button className="welcome-card" onClick={() => openScratch()}>
          <FilePlus2 size={22} />
          <span className="welcome-card-title">New request</span>
          <span className="muted small">{modKey}+N</span>
        </button>
        <button className="welcome-card" onClick={() => void createCollection()}>
          <Library size={22} />
          <span className="welcome-card-title">New collection</span>
          <span className="muted small">{modKey}+Shift+N</span>
        </button>
        <button className="welcome-card" onClick={() => openModal('import')}>
          <Import size={22} />
          <span className="welcome-card-title">Import a collection</span>
          <span className="muted small">{modKey}+O</span>
        </button>
        <button className="welcome-card" onClick={() => void openDemoWorkspace()}>
          <Compass size={22} />
          <span className="welcome-card-title">Try the demo</span>
          <span className="muted small">Public APIs, no setup</span>
        </button>
      </div>
      <div className="shortcuts">
        <div>
          <kbd>{modKey}</kbd>+<kbd>Enter</kbd> send
        </div>
        <div>
          <kbd>{modKey}</kbd>+<kbd>S</kbd> save
        </div>
        <div>
          <kbd>{modKey}</kbd>+<kbd>B</kbd> toggle sidebar
        </div>
        <div>
          <kbd>{modKey}</kbd>+<kbd>W</kbd> close tab
        </div>
      </div>
    </div>
  )
}
