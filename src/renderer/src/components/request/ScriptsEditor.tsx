import { useRef, useState } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import type { Scripts } from '@shared/types'
import { CodeEditor } from '../editor/CodeEditor'
import { Tabs } from '../ui'

const SNIPPETS: Record<keyof Scripts, { label: string; code: string }[]> = {
  preRequest: [
    { label: 'Set an environment variable', code: "pm.environment.set('key', 'value')" },
    { label: 'Set a request-scoped variable', code: "pm.variables.set('key', 'value')" },
    { label: 'Add a header', code: "pm.request.headers.upsert({ key: 'X-Request-Id', value: crypto.randomUUID() })" },
    { label: 'Timestamp variable', code: "pm.variables.set('now', new Date().toISOString())" },
    {
      label: 'HMAC signature (CryptoJS)',
      code: "const sig = CryptoJS.HmacSHA256(pm.request.body.raw, pm.environment.get('secret')).toString()\npm.request.headers.upsert({ key: 'X-Signature', value: sig })"
    },
    {
      label: 'Fetch a token first',
      code: "const res = await pm.sendRequest({\n  url: pm.variables.replaceIn('{{baseUrl}}/auth/token'),\n  method: 'POST',\n  header: { 'Content-Type': 'application/json' },\n  body: { mode: 'raw', raw: JSON.stringify({ client_id: pm.environment.get('clientId') }) }\n})\npm.environment.set('token', res.json().access_token)"
    },
    { label: 'Skip this request', code: 'pm.execution.skipRequest()' }
  ],
  test: [
    { label: 'Status code is 200', code: "pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200)\n})" },
    {
      label: 'Response time below 500ms',
      code: "pm.test('Response time is below 500ms', () => {\n  pm.expect(pm.response.responseTime).to.be.below(500)\n})"
    },
    {
      label: 'JSON value check',
      code: "pm.test('Has expected value', () => {\n  const json = pm.response.json()\n  pm.expect(json.id).to.eql(1)\n})"
    },
    {
      label: 'Header is present',
      code: "pm.test('Content-Type is present', () => {\n  pm.response.to.have.header('Content-Type')\n})"
    },
    {
      label: 'Body contains string',
      code: "pm.test('Body contains text', () => {\n  pm.expect(pm.response.text()).to.include('text')\n})"
    },
    {
      label: 'Save value from response',
      code: "const json = pm.response.json()\npm.environment.set('token', json.token)"
    },
    { label: 'Log the response', code: 'console.log(pm.response.json())' }
  ]
}

interface Props {
  scripts: Scripts
  onChange: (key: keyof Scripts, value: string) => void
  onSend?: () => void
  /** Context note, e.g. "Runs before every request in this folder". */
  scopeNote?: string
}

export function ScriptsEditor({ scripts, onChange, onSend, scopeNote }: Props) {
  const [which, setWhich] = useState<keyof Scripts>('preRequest')
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  const insert = (code: string) => {
    const view = editorRef.current?.view
    if (!view) return onChange(which, scripts[which] ? `${scripts[which]}\n\n${code}` : code)
    const { to } = view.state.selection.main
    const doc = view.state.doc.toString()
    const prefix = to > 0 && !doc.slice(0, to).endsWith('\n\n') ? (doc.slice(0, to).endsWith('\n') ? '\n' : '\n\n') : ''
    view.dispatch({ changes: { from: to, insert: prefix + code + '\n' }, selection: { anchor: to + prefix.length + code.length + 1 } })
    view.focus()
  }

  return (
    <div className="scripts-editor">
      <Tabs
        className="subtabs-small"
        value={which}
        onChange={setWhich}
        tabs={[
          { id: 'preRequest', label: 'Before request', badge: scripts.preRequest.trim() ? '●' : undefined },
          { id: 'test', label: 'After response', badge: scripts.test.trim() ? '●' : undefined }
        ]}
      />
      <div className="scripts-body">
        <div className="scripts-code">
          <CodeEditor
            key={which}
            editorRef={editorRef}
            value={scripts[which]}
            onChange={(v) => onChange(which, v)}
            language="javascript"
            onModEnter={onSend}
            placeholder={
              which === 'preRequest'
                ? '// Runs before the request is sent.\n// e.g. pm.environment.set("ts", Date.now())'
                : '// Runs after the response arrives.\n// e.g. pm.test("ok", () => pm.response.to.have.status(200))'
            }
          />
        </div>
        <aside className="snippets">
          <div className="snippets-title">Snippets</div>
          {SNIPPETS[which].map((s) => (
            <button key={s.label} className="snippet" onClick={() => insert(s.code)}>
              {s.label}
            </button>
          ))}
          <p className="hint">
            {scopeNote ?? 'Scripts use the familiar pm.* API, so most existing scripts work as-is.'} Available: pm, console,
            CryptoJS, _ (lodash), require('chai' | 'lodash' | 'crypto-js' | 'uuid').
          </p>
        </aside>
      </div>
    </div>
  )
}
