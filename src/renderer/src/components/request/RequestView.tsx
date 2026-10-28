import { useMemo, useRef, useState } from 'react'
import { ChevronRight, Code2, Save, Send, Share, Square, Timer } from 'lucide-react'
import { ITEM_EXPORT_FORMATS } from '@shared/itemExport'
import { exportRequestTab } from '../../lib/exports'
import { kv } from '@shared/model'
import { parseCurl } from '@shared/importers'
import { paramsFromUrl, pathVariablesFromUrl, urlWithParams } from '@shared/url'
import { HTTP_METHODS, type ApiRequest } from '@shared/types'
import { useWorkspace, type RequestTab } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { prompt, toast, useDialogs } from '../../store/dialogs'
import { cancelTab, sendTab } from '../../lib/runner'
import { findPath } from '@shared/tree'
import { effectiveAuth } from '@shared/engine/prepare'
import { VarScopesContext } from '../editor/variables'
import { VarInput } from '../editor/VarInput'
import { CodeEditor } from '../editor/CodeEditor'
import { KeyValueEditor, COMMON_HEADERS } from '../KeyValueEditor'
import { InlineEdit, MethodBadge, Splitter, Tabs, modKey, openMenu } from '../ui'
import { AuthEditor } from './AuthEditor'
import { BodyEditor } from './BodyEditor'
import { ScriptsEditor } from './ScriptsEditor'
import { RequestCapturesEditor } from './CapturesEditor'
import { ResponseView } from '../response/ResponseView'
import { useScopes } from '../../lib/useScopes'
import { saveActiveTab } from '../../lib/actions'

type SubTab = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'captures' | 'notes'
const subTabMemory = new Map<string, SubTab>()

/** Keeps the path-variable table in step with the URL's `:name` segments (and absent when there are none). */
function syncPathVariables(r: ApiRequest): void {
  const vars = pathVariablesFromUrl(r.url, r.pathVariables)
  if (vars.length) r.pathVariables = vars
  else delete r.pathVariables
}

export function RequestView({ tab }: { tab: RequestTab }) {
  const updateDraft = useWorkspace((s) => s.updateDraft)
  const layout = useWorkspace((s) => s.settings.layout)
  const splitRatio = useWorkspace((s) => s.splitRatio)
  const setSplitRatio = useWorkspace((s) => s.setSplitRatio)
  const sending = useRuntime((s) => !!s.sending[tab.id])
  const streaming = useRuntime((s) => !!s.live[tab.id]?.head)
  const scopesRef = useScopes(tab.collectionId, tab.id)
  // Hooks must run on every render, so this can't be called only when the Auth tab is showing.
  const inheritedLabel = useInheritedLabel(tab)
  const [sub, setSubState] = useState<SubTab>(() => subTabMemory.get(tab.id) ?? (tab.draft.body.mode !== 'none' ? 'body' : 'params'))
  const setSub = (s: SubTab) => {
    subTabMemory.set(tab.id, s)
    setSubState(s)
  }
  const containerRef = useRef<HTMLDivElement>(null)
  const startRatio = useRef(splitRatio)

  const req = tab.draft
  const update = (recipe: (r: ApiRequest) => void) => updateDraft(tab.id, recipe)
  const send = () => void sendTab(tab.id)

  const onUrlPaste = (text: string): boolean => {
    if (!/^\s*curl\s/i.test(text)) return false
    try {
      const parsed = parseCurl(text)
      update((r) => {
        if (!r.url.trim() && (!tab.requestId || /^(Untitled|New) request$/.test(r.name))) r.name = parsed.name
        r.method = parsed.method
        r.url = parsed.url
        r.params = parsed.params
        syncPathVariables(r)
        r.headers = parsed.headers
        r.body = parsed.body
        if (parsed.auth.type !== 'inherit') r.auth = parsed.auth
      })
      toast('Imported cURL command', 'success')
      return true
    } catch {
      return false
    }
  }

  const enabledCount = (rows: { enabled: boolean; key: string }[]) => rows.filter((r) => r.enabled && r.key).length
  // Derived from the URL, so requests saved before path variables existed show theirs too.
  const pathVars = pathVariablesFromUrl(req.url, req.pathVariables)

  const editor = (
    <div className="request-pane">
      <div className="url-bar">
        <MethodSelect value={req.method} onChange={(m) => update((r) => void (r.method = m))} />
        <VarInput
          className="url-input"
          value={req.url}
          placeholder="Enter a URL or paste a cURL command"
          onChange={(url) =>
            update((r) => {
              r.url = url
              r.params = paramsFromUrl(url, r.params)
              syncPathVariables(r)
            })
          }
          onEnter={send}
          onPaste={onUrlPaste}
          autoFocus={!req.url}
        />
        {sending ? (
          <button
            className="btn danger send-btn"
            onClick={() => cancelTab(tab.id)}
            title={streaming ? 'Stop and keep what arrived' : undefined}
          >
            <Square size={13} /> {streaming ? 'Stop' : 'Cancel'}
          </button>
        ) : (
          <button className="btn primary send-btn" onClick={send} disabled={!req.url.trim()} title={`Send (${modKey}+Enter)`}>
            <Send size={14} /> Send
          </button>
        )}
      </div>

      <Tabs<SubTab>
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'params', label: 'Params', badge: enabledCount(req.params) + pathVars.length || undefined },
          { id: 'headers', label: 'Headers', badge: enabledCount(req.headers) || undefined },
          { id: 'body', label: 'Body', badge: req.body.mode !== 'none' ? '●' : undefined },
          { id: 'auth', label: 'Auth', badge: req.auth.type !== 'inherit' && req.auth.type !== 'none' ? '●' : undefined },
          {
            id: 'scripts',
            label: 'Scripts',
            badge: req.scripts.preRequest.trim() || req.scripts.test.trim() ? '●' : undefined
          },
          { id: 'captures', label: 'Capture', badge: (req.captures ?? []).filter((c) => c.enabled && c.variable.trim()).length || undefined },
          { id: 'notes', label: 'Notes', badge: req.description.trim() ? '●' : undefined }
        ]}
      />

      <div className="request-sub">
        {sub === 'params' && (
          <div className="scroll-pad">
            {pathVars.length > 0 && <h4 className="kv-section-title">Query parameters</h4>}
            <KeyValueEditor
              rows={req.params}
              onChange={(params) =>
                update((r) => {
                  r.params = params
                  r.url = urlWithParams(r.url, params)
                })
              }
              create={(id) => ({ ...kv(), id })}
              keyPlaceholder="parameter"
              showDescription
            />
            {pathVars.length > 0 && (
              <>
                <h4 className="kv-section-title">Path variables</h4>
                <KeyValueEditor
                  rows={pathVars}
                  onChange={(vars) => update((r) => void (r.pathVariables = vars))}
                  create={(id) => ({ ...kv(), id })}
                  valuePlaceholder="value (empty sends :name as typed)"
                  showDescription
                  fixedKeys
                />
              </>
            )}
            <p className="hint pad">
              Query parameters stay in sync with the URL. Write a path segment as <code>:name</code> (like{' '}
              <code>/users/:id</code>) to give it a value here.
            </p>
          </div>
        )}
        {sub === 'headers' && <HeadersTab req={req} update={update} />}
        {sub === 'body' && <BodyEditor body={req.body} onChange={(recipe) => update((r) => recipe(r.body))} onSend={send} />}
        {sub === 'auth' && (
          <div className="scroll-pad">
            <AuthEditor auth={req.auth} onChange={(a) => update((r) => void (r.auth = a))} inheritedLabel={inheritedLabel} />
          </div>
        )}
        {sub === 'scripts' && (
          <ScriptsEditor scripts={req.scripts} onChange={(k, v) => update((r) => void (r.scripts[k] = v))} onSend={send} />
        )}
        {sub === 'captures' && (
          <RequestCapturesEditor
            tabId={tab.id}
            inCollection={!!tab.collectionId}
            captures={req.captures ?? []}
            onChange={(list) =>
              update((r) => {
                if (list.length) r.captures = list
                else delete r.captures
              })
            }
          />
        )}
        {sub === 'notes' && (
          <CodeEditor
            value={req.description}
            onChange={(v) => update((r) => void (r.description = v))}
            lineNumbers={false}
            placeholder="Notes about this request (Markdown welcome)…"
          />
        )}
      </div>
    </div>
  )

  return (
    <VarScopesContext.Provider value={scopesRef}>
      <div className="request-view">
        <RequestHeader tab={tab} />
        <div ref={containerRef} className={`split split-${layout}`}>
          <div className="split-a" style={{ flexBasis: `${splitRatio * 100}%` }}>
            {editor}
          </div>
          <Splitter
            direction={layout === 'side' ? 'vertical' : 'horizontal'}
            onDrag={(delta) => {
              const el = containerRef.current
              if (!el) return
              const size = layout === 'side' ? el.clientWidth : el.clientHeight
              setSplitRatio(startRatio.current + delta / size)
            }}
            onStart={() => (startRatio.current = useWorkspace.getState().splitRatio)}
          />
          <div className="split-b">
            <ResponseView tabId={tab.id} />
          </div>
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}

function HeadersTab({ req, update }: { req: ApiRequest; update: (recipe: (r: ApiRequest) => void) => void }) {
  const [bulk, setBulk] = useState(false)
  return (
    <div className="scroll-pad">
      <div className="kv-toolbar">
        <span className="hint">Content-Type is added automatically from the body when not set here.</span>
        <button className="btn ghost small" onClick={() => setBulk(!bulk)}>
          {bulk ? 'Table view' : 'Bulk edit'}
        </button>
      </div>
      <KeyValueEditor
        rows={req.headers}
        onChange={(headers) => update((r) => void (r.headers = headers))}
        create={(id) => ({ ...kv(), id })}
        keyPlaceholder="Header"
        keySuggestions={COMMON_HEADERS}
        showDescription
        bulk={bulk}
      />
    </div>
  )
}

function useInheritedLabel(tab: RequestTab): string | undefined {
  const collection = useWorkspace((s) => s.collections.find((c) => c.id === tab.collectionId))
  return useMemo(() => {
    if (!collection || !tab.requestId) return 'Scratch requests have no parent; save it to a collection to inherit auth.'
    const parents = findPath(collection, tab.requestId)?.parents ?? []
    const auth = effectiveAuth(tab.draft, parents, collection)
    let from = collection.name
    for (let i = parents.length - 1; i >= 0; i--)
      if (parents[i].auth.type !== 'inherit') {
        from = parents[i].name
        break
      }
    const names: Record<string, string> = {
      none: 'No auth',
      bearer: 'Bearer token',
      basic: 'Basic auth',
      apikey: 'API key',
      oauth2: 'OAuth 2.0 token'
    }
    return `Currently inherits: ${names[auth.type] ?? auth.type} from “${from}”.`
  }, [collection, tab.requestId, tab.draft])
}

function MethodSelect({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const known = HTTP_METHODS.includes(value)
  return (
    <div className={`method-select method-${value.toLowerCase()}`}>
      <select
        value={known ? value : '__custom'}
        onChange={async (e) => {
          if (e.target.value === '__other') {
            const m = await prompt({ title: 'Custom method', label: 'HTTP method', placeholder: 'PROPFIND' })
            if (m?.trim()) onChange(m.trim().toUpperCase())
          } else onChange(e.target.value)
        }}
      >
        {HTTP_METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {!known && <option value="__custom">{value}</option>}
        <option value="__other">Custom…</option>
      </select>
    </div>
  )
}

function RequestHeader({ tab }: { tab: RequestTab }) {
  const collection = useWorkspace((s) => s.collections.find((c) => c.id === tab.collectionId))
  const renameItem = useWorkspace((s) => s.renameItem)
  const updateDraft = useWorkspace((s) => s.updateDraft)
  const openModal = useDialogs((s) => s.openModal)
  const [editing, setEditing] = useState(false)
  const parents = collection && tab.requestId ? (findPath(collection, tab.requestId)?.parents ?? []) : []

  const rename = (name: string) => {
    if (collection && tab.requestId) renameItem(collection.id, tab.requestId, name)
    else updateDraft(tab.id, (r) => void (r.name = name))
  }

  return (
    <div className="request-header">
      <div className="breadcrumb">
        <MethodBadge method={tab.draft.method} />
        {collection ? (
          <>
            <span className="crumb">{collection.name}</span>
            {parents.map((p) => (
              <span key={p.id} className="crumb-wrap">
                <ChevronRight size={12} className="crumb-sep" />
                <span className="crumb">{p.name}</span>
              </span>
            ))}
            <ChevronRight size={12} className="crumb-sep" />
          </>
        ) : (
          <span className="crumb scratch">Unsaved</span>
        )}
        {editing ? (
          <InlineEdit value={tab.draft.name} onCommit={rename} onCancel={() => setEditing(false)} />
        ) : (
          <span className="crumb current" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {tab.draft.name}
          </span>
        )}
      </div>
      <div className="request-actions">
        <TemporaryValues tab={tab} />
        <button
          className="btn ghost small"
          title="Download this request as a file you can import here or in other API clients"
          onClick={(e) =>
            openMenu(
              e,
              ITEM_EXPORT_FORMATS.map((f) => ({ label: f.menuLabel, onClick: () => void exportRequestTab(tab.id, f.id) }))
            )
          }
        >
          <Share size={14} /> Export
        </button>
        <button className="btn ghost small" onClick={() => openModal('codegen', { tabId: tab.id })} title="Generate code">
          <Code2 size={14} /> Code
        </button>
        <button
          className={`btn small ${tab.dirty || !tab.requestId ? 'secondary' : 'ghost'}`}
          onClick={() => saveActiveTab()}
          title={`Save (${modKey}+S)`}
        >
          <Save size={14} /> Save
        </button>
      </div>
    </div>
  )
}

/** Values set "for this tab only": shown so they are never a surprise, and easy to clear. */
function TemporaryValues({ tab }: { tab: RequestTab }) {
  const vars = useRuntime((s) => s.tabVars[tab.id])
  const clear = useRuntime((s) => s.clearTabVars)
  const openModal = useDialogs((s) => s.openModal)
  const entries = Object.entries(vars ?? {})
  if (!entries.length) return null
  return (
    <button
      className="temp-chip"
      title="Temporary values for this tab: used when sending, never saved"
      onClick={(e) =>
        openMenu(e, [
          ...entries.map(([k, v]) => ({
            label: `${k} = ${v.length > 40 ? v.slice(0, 40) + '…' : v}`,
            onClick: () => openModal('variable', { name: k, collectionId: tab.collectionId, tabId: tab.id })
          })),
          { separator: true as const },
          { label: 'Clear temporary values', danger: true, onClick: () => clear(tab.id) }
        ])
      }
    >
      <Timer size={12} /> {entries.length} temporary
    </button>
  )
}
