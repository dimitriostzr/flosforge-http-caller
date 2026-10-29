import { FileUp, Paperclip, Wand2, X } from 'lucide-react'
import { formField, kv } from '@shared/model'
import type { BodyMode, FormField, RawLanguage, RequestBody } from '@shared/types'
import { CodeEditor } from '../editor/CodeEditor'
import { KeyValueEditor } from '../KeyValueEditor'
import { prettyJson, prettyXml } from '../../lib/format'
import { toast } from '../../store/dialogs'

const MODES: { id: BodyMode; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'raw', label: 'Raw' },
  { id: 'formdata', label: 'Multipart form' },
  { id: 'urlencoded', label: 'URL-encoded form' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'binary', label: 'File' }
]

const LANGS: { id: RawLanguage; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'text', label: 'Text' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'javascript', label: 'JavaScript' }
]

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p

interface Props {
  body: RequestBody
  onChange: (recipe: (b: RequestBody) => void) => void
  onSend: () => void
}

export function BodyEditor({ body, onChange, onSend }: Props) {
  const beautify = () => {
    onChange((b) => {
      if (b.rawLanguage === 'json') {
        const pretty = prettyJson(b.raw)
        if (pretty === b.raw && b.raw.trim()) {
          try {
            JSON.parse(b.raw)
          } catch (e) {
            toast(`Invalid JSON: ${(e as Error).message}`, 'error')
          }
        }
        b.raw = pretty
      } else if (b.rawLanguage === 'xml' || b.rawLanguage === 'html') b.raw = prettyXml(b.raw)
    })
  }

  return (
    <div className="body-editor">
      <div className="body-modes">
        {MODES.map((m) => (
          <label key={m.id} className={`radio-chip ${body.mode === m.id ? 'active' : ''}`}>
            <input
              type="radio"
              name="body-mode"
              checked={body.mode === m.id}
              onChange={() => onChange((b) => void (b.mode = m.id))}
            />
            {m.label}
          </label>
        ))}
        <div className="spacer" />
        {body.mode === 'raw' && (
          <>
            <select
              className="select small"
              value={body.rawLanguage}
              onChange={(e) => onChange((b) => void (b.rawLanguage = e.target.value as RawLanguage))}
            >
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            {['json', 'xml', 'html'].includes(body.rawLanguage) && (
              <button className="btn ghost small" onClick={beautify} title="Format">
                <Wand2 size={13} /> Format
              </button>
            )}
          </>
        )}
      </div>

      <div className="body-content">
        {body.mode === 'none' && <div className="muted-center">This request has no body.</div>}

        {body.mode === 'raw' && (
          <CodeEditor
            value={body.raw}
            onChange={(v) => onChange((b) => void (b.raw = v))}
            language={body.rawLanguage}
            variables
            onModEnter={onSend}
            placeholder={body.rawLanguage === 'json' ? '{\n  "hello": "{{name}}"\n}' : ''}
          />
        )}

        {body.mode === 'urlencoded' && (
          <div className="scroll-pad">
            <KeyValueEditor
              rows={body.urlencoded}
              onChange={(rows) => onChange((b) => void (b.urlencoded = rows))}
              create={(id) => ({ ...kv(), id })}
              showDescription
            />
          </div>
        )}

        {body.mode === 'formdata' && (
          <div className="scroll-pad">
            <KeyValueEditor<FormField>
              rows={body.formdata}
              onChange={(rows) => onChange((b) => void (b.formdata = rows))}
              create={(id) => ({ ...formField(), id })}
              extraHeader="Type"
              renderExtra={(row, update) => (
                <select
                  className="select small"
                  value={row.kind}
                  onChange={(e) => update({ kind: e.target.value as FormField['kind'] })}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              )}
              renderValue={(row, update) =>
                row.kind === 'file' ? (
                  <FilePicker files={row.files ?? []} onChange={(files) => update({ files })} multi />
                ) : undefined
              }
            />
          </div>
        )}

        {body.mode === 'binary' && (
          <div className="binary-body">
            <FilePicker
              files={body.binaryPath ? [body.binaryPath] : []}
              onChange={(files) => onChange((b) => void (b.binaryPath = files[0] ?? ''))}
            />
            <p className="hint">The file is read from disk at send time and sent as the raw request body.</p>
          </div>
        )}

        {body.mode === 'graphql' && (
          <div className="graphql-body">
            <div className="graphql-pane">
              <div className="pane-label">Query</div>
              <CodeEditor
                value={body.graphql.query}
                onChange={(v) => onChange((b) => void (b.graphql.query = v))}
                language="graphql"
                variables
                onModEnter={onSend}
                placeholder={'query {\n  viewer { id }\n}'}
              />
            </div>
            <div className="graphql-pane">
              <div className="pane-label">Variables (JSON)</div>
              <CodeEditor
                value={body.graphql.variables}
                onChange={(v) => onChange((b) => void (b.graphql.variables = v))}
                language="json"
                variables
                onModEnter={onSend}
                placeholder={'{\n  "id": 1\n}'}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FilePicker({ files, onChange, multi }: { files: string[]; onChange: (f: string[]) => void; multi?: boolean }) {
  const pick = async () => {
    const picked = await window.api.pickFiles(!!multi)
    if (picked.length) onChange(multi ? [...files, ...picked] : picked)
  }
  return (
    <div className="file-picker">
      {files.map((f) => (
        <span key={f} className="file-chip" title={f}>
          <Paperclip size={11} />
          {basename(f)}
          <button className="icon-btn subtle tiny" onClick={() => onChange(files.filter((x) => x !== f))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <button className="btn ghost small" onClick={pick}>
        <FileUp size={13} /> {files.length ? (multi ? 'Add' : 'Change') : 'Choose file'}
      </button>
    </div>
  )
}
