import { useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { completionStatus } from '@codemirror/autocomplete'
import { baseTheme } from './cmTheme'
import { refreshVars, useScopesRef, variableSupport } from './variables'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  onEnter?: () => void
  /** Return true to swallow the paste (e.g. a cURL command pasted into the URL bar). */
  onPaste?: (text: string) => boolean
  autoFocus?: boolean
  masked?: boolean
  readOnly?: boolean
}

/** Single-line input with {{variable}} highlighting, hover values and autocomplete. */
export function VarInput({ value, onChange, placeholder, className, onEnter, onPaste, autoFocus, masked, readOnly }: Props) {
  const scopes = useScopesRef()
  const ref = useRef<ReactCodeMirrorRef>(null)
  const handlers = useRef({ onEnter, onPaste })
  handlers.current = { onEnter, onPaste }

  const extensions = useMemo(
    () => [
      baseTheme,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      variableSupport(scopes),
      placeholderExt(placeholder ?? ''),
      // Keep it on one line: flatten newlines in typed/pasted text.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || !tr.newDoc.toString().includes('\n')) return tr
        const flat = tr.newDoc.toString().replace(/\r?\n/g, ' ')
        return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: flat }, sequential: true }]
      }),
      EditorView.domEventHandlers({
        paste: (e) => {
          const text = e.clipboardData?.getData('text/plain') ?? ''
          if (handlers.current.onPaste?.(text)) {
            e.preventDefault()
            return true
          }
          return false
        }
      }),
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            run: (view) => {
              // Let the autocomplete popup take Enter when it's open.
              if (completionStatus(view.state) === 'active') return false
              handlers.current.onEnter?.()
              return true
            }
          }
        ])
      ),
      ...(readOnly ? [EditorState.readOnly.of(true)] : [])
    ],
    [scopes, placeholder, readOnly]
  )

  // Recolor variables when their values change (scopes.current is replaced only then).
  const values = scopes.current
  useEffect(() => {
    ref.current?.view?.dispatch({ effects: refreshVars.of(null) })
  }, [values])

  return (
    <CodeMirror
      ref={ref}
      className={`var-input ${masked ? 'masked' : ''} ${className ?? ''}`}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      autoFocus={autoFocus}
      editable={!readOnly}
      basicSetup={false}
      indentWithTab={false}
    />
  )
}
