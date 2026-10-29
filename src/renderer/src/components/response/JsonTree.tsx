import { useState } from 'react'
import { ChevronRight, Code2, Copy, Pipette } from 'lucide-react'
import { toast } from '../../store/dialogs'
import { accessor, copyText, isContainer, preview, typeOf, type JsonPath } from '../../lib/jsonView'

const CHUNK = 200

interface TreeProps {
  data: unknown
  /** Levels open on first render; changing it (with a new key) re-expands/collapses everything. */
  openDepth: number
  /** Offers to capture a value into a variable. */
  onCapture?: (path: JsonPath) => void
  /** Picking mode: clicking a value (not a container) calls onCapture with it. */
  pickOnClick?: boolean
}

export function JsonTree({ data, openDepth, onCapture, pickOnClick }: TreeProps) {
  return (
    <div className={`json-tree ${pickOnClick ? 'picking' : ''}`} role="tree">
      <Node name={null} value={data} path={[]} depth={0} openDepth={openDepth} onCapture={onCapture} pick={pickOnClick} />
    </div>
  )
}

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text)
  toast(`Copied ${what}`)
}

function Node({
  name,
  value,
  path,
  depth,
  openDepth,
  onCapture,
  pick
}: {
  name: string | number | null
  value: unknown
  path: JsonPath
  depth: number
  openDepth: number
  onCapture?: (path: JsonPath) => void
  pick?: boolean
}) {
  const container = isContainer(value)
  const entries: [string | number, unknown][] = container
    ? Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value)
    : []
  // Huge arrays start closed even within openDepth, so a 10k-row response renders instantly.
  const [open, setOpen] = useState(container && depth < openDepth && (depth === 0 || entries.length <= 100))
  const [limit, setLimit] = useState(CHUNK)
  const type = typeOf(value)

  return (
    <div role="treeitem" aria-expanded={container ? open : undefined}>
      <div
        className={`jt-row ${container ? 'jt-container' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => (container ? setOpen(!open) : pick && onCapture?.(path))}
        title={pick && !container ? 'Use this value' : undefined}
      >
        <span className="jt-caret">{container && <ChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />}</span>
        {name !== null && (
          <>
            <span className={typeof name === 'number' ? 'jt-index' : 'jt-key'}>{typeof name === 'number' ? name : `"${name}"`}</span>
            <span className="jt-colon">:</span>
          </>
        )}
        {container ? (
          <span className="jt-summary">
            {Array.isArray(value) ? '[' : '{'}
            {!open && <span className="jt-count"> {preview(value)} </span>}
            {!open && (Array.isArray(value) ? ']' : '}')}
          </span>
        ) : (
          <span className={`jt-value jt-${type}`}>{type === 'string' ? JSON.stringify(value) : String(value)}</span>
        )}
        <span className="jt-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn subtle" title="Copy value" onClick={() => copy(copyText(value), 'value')}>
            <Copy size={12} />
          </button>
          <button className="icon-btn subtle" title={`Copy path for scripts: ${accessor(path)}`} onClick={() => copy(accessor(path), 'path')}>
            <Code2 size={12} />
          </button>
          {onCapture && (
            <button className="icon-btn subtle" title="Capture into a variable on every send" onClick={() => onCapture(path)}>
              <Pipette size={12} />
            </button>
          )}
        </span>
      </div>
      {container && open && (
        <>
          {entries.slice(0, limit).map(([k, v]) => (
            <Node key={k} name={k} value={v} path={[...path, k]} depth={depth + 1} openDepth={openDepth} onCapture={onCapture} pick={pick} />
          ))}
          {entries.length > limit && (
            <button className="jt-more" style={{ marginLeft: 24 + depth * 16 }} onClick={() => setLimit(limit + CHUNK)}>
              Show {Math.min(CHUNK, entries.length - limit)} more of {entries.length - limit} remaining
            </button>
          )}
          <div className="jt-row jt-close" style={{ paddingLeft: 8 + depth * 16 }}>
            <span className="jt-caret" />
            {Array.isArray(value) ? ']' : '}'}
          </div>
        </>
      )}
    </div>
  )
}
