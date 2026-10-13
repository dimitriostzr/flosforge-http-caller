import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { CODEGEN_TARGETS, generateCode, type CodegenTarget } from '@shared/codegen'
import { useWorkspace } from '../../store/workspace'
import { toast, useDialogs } from '../../store/dialogs'
import { previewPrepared } from '../../lib/runner'
import { CodeEditor, type EditorLanguage } from '../editor/CodeEditor'
import { Modal } from '../ui'

const LANG: Record<CodegenTarget, EditorLanguage> = {
  curl: 'text',
  fetch: 'javascript',
  python: 'text',
  httpie: 'text',
  go: 'text'
}

let lastTarget: CodegenTarget = 'curl'

export function CodegenModal({ tabId }: { tabId: string }) {
  const close = useDialogs((s) => s.closeModal)
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === tabId))
  // Re-render when environments/variables change so the snippet stays current.
  useWorkspace((s) => s.environments)
  useWorkspace((s) => s.activeEnvironmentId)
  const [target, setTarget] = useState<CodegenTarget>(lastTarget)

  const code = useMemo(() => {
    if (tab?.kind !== 'request') return ''
    try {
      return generateCode(target, previewPrepared(tab))
    } catch (e) {
      return `// ${(e as Error).message}`
    }
  }, [tab, target])

  if (tab?.kind !== 'request') return null
  return (
    <Modal title="Code snippet" onClose={close} width={760} className="codegen-modal">
      <div className="codegen-bar">
        <div className="seg">
          {CODEGEN_TARGETS.map((t) => (
            <button
              key={t.id}
              className={t.id === target ? 'active' : ''}
              onClick={() => {
                lastTarget = t.id
                setTarget(t.id)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          className="btn primary small"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            toast('Copied to clipboard', 'success')
          }}
        >
          <Copy size={13} /> Copy
        </button>
      </div>
      <div className="codegen-code">
        <CodeEditor value={code} readOnly language={LANG[target]} lineNumbers={false} />
      </div>
      <p className="hint">Variables are resolved with the active environment. Pre-request scripts are not run.</p>
    </Modal>
  )
}
