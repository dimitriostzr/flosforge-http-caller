import type { VarMap } from './variables'

// Runner data files: one row per iteration, its columns available as
// {{variables}} (and pm.iterationData). CSV with a header row, or a JSON array
// of objects, the formats collection runners commonly accept.

export interface DataFile {
  rows: VarMap[]
  columns: string[]
}

export function parseDataFile(text: string, fileName = ''): DataFile {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (!trimmed) throw new Error('The data file is empty')
  const looksJson = fileName.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')
  return looksJson ? parseJsonData(trimmed) : parseCsv(trimmed)
}

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

function parseJsonData(text: string): DataFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`The data file is not valid JSON: ${(e as Error).message}`)
  }
  if (!Array.isArray(data)) throw new Error('A JSON data file must be an array of objects, one per iteration')
  const columns: string[] = []
  const rows = data.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Row ${i + 1} is not an object`)
    const row: VarMap = {}
    for (const [k, v] of Object.entries(item)) {
      if (!columns.includes(k)) columns.push(k)
      row[k] = asString(v)
    }
    return row
  })
  return { rows, columns }
}

/** RFC 4180 CSV: quoted fields, "" escapes, line breaks inside quotes. The separator is detected from the header. */
export function parseCsv(text: string): DataFile {
  const firstLine = text.split(/\r?\n/, 1)[0]
  const separator = [',', ';', '\t'].reduce((best, s) => (count(firstLine, s) > count(firstLine, best) ? s : best), ',')

  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === separator) {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else field += c
  }
  if (quoted) throw new Error('The CSV file has an unterminated quoted field')
  record.push(field)
  records.push(record)

  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ''))
  const [header, ...body] = nonEmpty
  const columns = header.map((h) => h.trim())
  if (columns.some((c) => !c)) throw new Error('Every CSV column needs a name in the header row')
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])))
  return { rows, columns }
}

function count(line: string, ch: string): number {
  let n = 0
  for (const c of line) if (c === ch) n++
  return n
}
