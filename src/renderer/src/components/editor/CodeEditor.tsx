import { useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { baseTheme, highlight } from './cmTheme'
import { refreshVars, useScopesRef, variableSupport } from './variables'

export type EditorLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'text' | 'css' | 'graphql'

const languageExt = (lang: EditorLanguage): Extension[] => {
  switch (lang) {
    case 'json':
      return [json()]
    case 'xml':
      return [xml()]
    case 'html':
      return [html()]
    case 'javascript':
      return [javascript()]
    default:
      return []
  }
}

interface Props {
  value: string
  onChange?: (v: string) => void
  language?: EditorLanguage
  readOnly?: boolean
  placeholder?: string
  /** Enable {{variable}} highlighting/autocomplete. */
  variables?: boolean
  lineWrapping?: boolean
  lineNumbers?: boolean
  /** Extra completions etc. */
  extensions?: Extension[]
  className?: string
  onModEnter?: () => void
  editorRef?: React.RefObject<ReactCodeMirrorRef | null>
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly,
  placeholder,
  variables,
  lineWrapping = true,
  lineNumbers = true,
  extensions,
  className,
  onModEnter,
  editorRef
}: Props) {
  const scopes = useScopesRef()
  const localRef = useRef<ReactCodeMirrorRef>(null)
  const ref = editorRef ?? localRef
  const modEnter = useRef(onModEnter)
  modEnter.current = onModEnter

  const exts = useMemo(() => {
    const list: Extension[] = [baseTheme, highlight, ...languageExt(language)]
    if (lineWrapping) list.push(EditorView.lineWrapping)
    if (variables) list.push(variableSupport(scopes))
    if (readOnly) list.push(EditorState.readOnly.of(true))
    list.push(
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              if (!modEnter.current) return false
              modEnter.current()
              return true
            }
          }
        ])
      )
    )
    if (extensions) list.push(...extensions)
    return list
  }, [language, lineWrapping, variables, readOnly, extensions, scopes])

  // Recolor variables when their values change (scopes.current is replaced only then).
  const values = scopes.current
  useEffect(() => {
    if (!variables) return
    ref.current?.view?.dispatch({ effects: refreshVars.of(null) })
  }, [variables, values, ref])

  return (
    <CodeMirror
      ref={ref}
      className={`code-editor ${className ?? ''}`}
      value={value}
      onChange={onChange}
      extensions={exts}
      theme="none"
      placeholder={placeholder}
      editable={!readOnly}
      height="100%"
      basicSetup={{
        lineNumbers,
        foldGutter: lineNumbers,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: !variables,
        tabSize: 2,
        searchKeymap: true
      }}
    />
  )
}
