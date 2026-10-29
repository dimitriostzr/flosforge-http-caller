import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Download, Search } from 'lucide-react'
import { exportTableCsv } from '../../lib/exports'
import {
  bestTablePath,
  compareCells,
  getAt,
  isContainer,
  pathLabel,
  preview,
  tableFor,
  typeOf,
  VALUE_COLUMN,
  type JsonPath
} from '../../lib/jsonView'

const PAGE = 500

/** Explores JSON as tables: arrays become rows, objects key/value; click a nested cell to open it. */
export function JsonTable({ data, fileBase = 'table' }: { data: unknown; fileBase?: string }) {
  const [path, setPathState] = useState<JsonPath>(() => bestTablePath(data))
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const setPath = (p: JsonPath) => {
    setPathState(p)
    setSort(null)
    setFilter('')
    setLimit(PAGE)
  }

  const value = getAt(data, path)
  const model = useMemo(() => tableFor(value), [value])
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = q
      ? model.rows.filter(
          (r) =>
            String(r.key).toLowerCase().includes(q) ||
            model.columns.some((c) => preview(r.cells[c], 500).toLowerCase().includes(q))
        )
      : model.rows
    if (sort) out = [...out].sort((a, b) => sort.dir * compareCells(a.cells[sort.col], b.cells[sort.col]))
    return out
  }, [model, filter, sort])

  const toggleSort = (col: string) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null))

  const isEntries = model.kind === 'entries'
  const firstHeader = isEntries ? 'key' : '#'

  return (
    <div className="json-table">
      <div className="jtab-bar">
        <nav className="jtab-crumbs">
          <button className={path.length === 0 ? 'current' : ''} onClick={() => setPath([])}>
            root
          </button>
          {path.map((p, i) => (
            <span key={i} className="jtab-crumb">
              <ChevronRight size={12} />
              <button className={i === path.length - 1 ? 'current' : ''} onClick={() => setPath(path.slice(0, i + 1))}>
                {typeof p === 'number' ? `[${p}]` : p}
              </button>
            </span>
          ))}
        </nav>
        <span className="muted small">
          {rows.length === model.rows.length ? model.rows.length : `${rows.length} of ${model.rows.length}`}{' '}
          {isEntries ? 'keys' : 'rows'}
        </span>
        <div className="panel-search inline jtab-filter">
          <Search size={13} />
          <input placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button
          className="btn ghost small"
          title="Download the rows shown (filtered and sorted) as CSV"
          onClick={() =>
            void exportTableCsv(
              [fileBase, ...path.map(String)].join('-'),
              [firstHeader, ...model.columns.map((c) => (isEntries && c === VALUE_COLUMN ? 'value' : c))],
              rows.map((r) => [r.key, ...model.columns.map((c) => r.cells[c])])
            )
          }
        >
          <Download size={13} /> CSV
        </button>
      </div>
      <div className="jtab-scroll">
        <table className="data-table jtab">
          <thead>
            <tr>
              <th className="jtab-key">{firstHeader}</th>
              {model.columns.map((c) => (
                <th key={c} onClick={() => toggleSort(c)} className="sortable" title="Sort">
                  {isEntries && c === VALUE_COLUMN ? 'value' : c}
                  {sort?.col === c && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => (
              <tr key={r.key}>
                <td className="jtab-key">
                  {isContainer(value) && isContainer(getAt(value, [r.key])) ? (
                    <button className="link" onClick={() => setPath([...path, r.key])} title={`Open ${pathLabel([...path, r.key])}`}>
                      {r.key}
                    </button>
                  ) : (
                    r.key
                  )}
                </td>
                {model.columns.map((c) => {
                  const cell = r.cells[c]
                  const cellPath = model.kind === 'rows' && c !== VALUE_COLUMN ? [...path, r.key, c] : [...path, r.key]
                  return (
                    <td key={c} className={`jtab-cell jt-${typeOf(cell)}`}>
                      {cell === undefined ? (
                        ''
                      ) : isContainer(cell) ? (
                        <button className="jtab-nested" onClick={() => setPath(cellPath)} title={`Open ${pathLabel(cellPath)}`}>
                          {preview(cell)}
                        </button>
                      ) : (
                        preview(cell, 300)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > limit && (
          <button className="jt-more" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} more rows
          </button>
        )}
      </div>
    </div>
  )
}
