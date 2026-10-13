import { createContext, useContext } from 'react'
import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state'
import { closeHoverTooltips, Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { dynamicVariables, emptyScopes, findVariableRefs, lookup, type Scopes } from '@shared/engine/variables'
import { useDialogs } from '../../store/dialogs'

// Variable awareness for editors: {{var}} highlighting (known vs unknown),
// hover tooltips with the resolved value and its scope, and autocomplete.

export type ScopesRef = {
  current: Scopes
  /** Where the editor lives, so "Set value" knows which collection and tab it is about. */
  ctx?: { collectionId: string | null; tabId: string | null }
}

export const VarScopesContext = createContext<ScopesRef>({ current: emptyScopes() })
export const useScopesRef = (): ScopesRef => useContext(VarScopesContext)

/** Send this effect to recolor variables after scopes change without a doc edit. */
export const refreshVars = StateEffect.define<null>()

const known = Decoration.mark({ class: 'cm-var cm-var-known' })
const unknown = Decoration.mark({ class: 'cm-var cm-var-unknown' })

function build(view: EditorView, ref: ScopesRef): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    for (const r of findVariableRefs(text))
      b.add(from + r.from, from + r.to, lookup(ref.current, r.name) ? known : unknown)
  }
  return b.finish()
}

const SOURCE_LABEL = {
  local: 'This tab (temporary)',
  data: 'Data file row',
  environment: 'Environment',
  collection: 'Collection',
  globals: 'Global',
  dynamic: 'Dynamic (generated each send)'
}

function openEditor(ref: ScopesRef, name: string): void {
  useDialogs.getState().openModal('variable', {
    name,
    collectionId: ref.ctx?.collectionId ?? null,
    tabId: ref.ctx?.tabId ?? null
  })
}

/** The {{variable}} under a document position, if any. */
function refAt(view: EditorView, pos: number): { name: string; from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos)
  const hit = findVariableRefs(line.text).find((r) => pos >= line.from + r.from && pos <= line.from + r.to)
  return hit ? { name: hit.name, from: line.from + hit.from, to: line.from + hit.to } : null
}

export function variableSupport(ref: ScopesRef): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, ref)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshVars))))
          this.decorations = build(u.view, ref)
      }
    },
    { decorations: (v) => v.decorations }
  )

  const tooltip = hoverTooltip((view, pos) => {
    const hit = refAt(view, pos)
    if (!hit) return null
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: (view) => {
        const dom = document.createElement('div')
        dom.className = 'var-tooltip'
        const res = lookup(ref.current, hit.name)
        const name = document.createElement('div')
        name.className = 'var-tooltip-name'
        name.textContent = hit.name
        const value = document.createElement('div')
        value.className = res ? 'var-tooltip-value' : 'var-tooltip-missing'
        value.textContent = res
          ? res.source === 'dynamic'
            ? 'e.g. ' + res.value
            : res.value || '(empty)'
          : 'Not defined in the active environment, collection or globals'
        dom.append(name, value)
        const foot = document.createElement('div')
        foot.className = 'var-tooltip-foot'
        const src = document.createElement('span')
        src.className = 'var-tooltip-source'
        src.textContent = res ? SOURCE_LABEL[res.source] : ''
        foot.append(src)
        if (!hit.name.startsWith('$')) {
          const edit = document.createElement('button')
          edit.className = 'var-tooltip-edit'
          edit.textContent = res ? 'Set value' : 'Define…'
          edit.title = 'Ctrl/⌘+click a variable to open this directly'
          edit.onmousedown = (e) => e.preventDefault()
          edit.onclick = () => {
            view.dispatch({ effects: closeHoverTooltips })
            openEditor(ref, hit.name)
          }
          foot.append(edit)
        }
        dom.append(foot)
        return { dom }
      }
    }
  })

  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\{\{[^{}]*$/)
    if (!m) return null
    const s = ref.current
    const seen = new Set<string>()
    const options = []
    for (const [scope, label] of [
      ['local', 'local'],
      ['environment', 'env'],
      ['collection', 'collection'],
      ['globals', 'global']
    ] as const) {
      for (const [k, v] of Object.entries(s[scope])) {
        if (seen.has(k)) continue
        seen.add(k)
        options.push({ label: k, detail: label, info: v.length > 80 ? v.slice(0, 80) + '…' : v, apply: `${k}}}` })
      }
    }
    for (const k of Object.keys(dynamicVariables))
      options.push({ label: k, detail: 'dynamic', apply: `${k}}}`, boost: -10 })
    return { from: m.from + 2, options, validFor: /^[^{}]*$/ }
  }

  const modClick = EditorView.domEventHandlers({
    mousedown: (e, view) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      const hit = pos === null ? null : refAt(view, pos)
      if (!hit || hit.name.startsWith('$')) return false
      e.preventDefault()
      openEditor(ref, hit.name)
      return true
    }
  })

  return [plugin, tooltip, modClick, autocompletion({ override: [complete], icons: false, activateOnTyping: true })]
}
