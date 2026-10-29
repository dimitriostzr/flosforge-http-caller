import { useMemo, useState } from 'react'
import { Copy, Plus, Search, Trash2 } from 'lucide-react'
import { uid } from '@shared/model'
import type { Appearance, CustomTheme } from '@shared/types'
import { useWorkspace } from '../../store/workspace'
import { confirm } from '../../store/dialogs'
import {
  BRAND_ACCENT,
  contrastInk,
  customToDef,
  findTheme,
  isPainted,
  resolveScheme,
  themeAccent
} from '../../theme/apply'
import { BUILTIN_THEMES, PAINTED_THEMES, type ThemeDef } from '../../theme/themes'
import { useSystemAccent, useSystemDark } from '../../theme/useTheme'
import { Toggle } from '../ui'

/** The built-in themes' surfaces (mirrors styles.css), for previews and as a starting point for custom themes. */
const BUILTIN_SURFACES = {
  dark: { window: '#111318', list: '#171A21', surface: '#1D2129', stroke: '#353C4B', card: '#1D2129', ink: '#E3E6EE' },
  light: { window: '#F3F4F7', list: '#FFFFFF', surface: '#F6F7FA', stroke: '#CDD2DD', card: '#FFFFFF', ink: '#1A1E28' }
}

interface Preview {
  window: string
  list: string
  surface: string
  stroke: string
  card: string
  ink: string
  accent: string
  secondary: string
}

function previewOf(t: ThemeDef, scheme: 'dark' | 'light', systemAccent: string | null): Preview {
  const accent = themeAccent(t, scheme, systemAccent)
  if (!isPainted(t)) return { ...BUILTIN_SURFACES[scheme], accent, secondary: scheme === 'dark' ? '#5CC6E0' : '#1D8AA6' }
  return {
    window: t.window!,
    list: t.list!,
    surface: t.surface!,
    stroke: t.stroke!,
    card: t.card!,
    ink: t.foreground ?? BUILTIN_SURFACES[scheme].ink,
    accent,
    secondary: t.secondary!
  }
}

export function AppearanceSettings() {
  const settings = useWorkspace((s) => s.settings)
  const update = useWorkspace((s) => s.updateSettings)
  const systemDark = useSystemDark()
  const systemAccent = useSystemAccent()
  const [filter, setFilter] = useState('')
  const current = findTheme(settings.themeId, settings.customThemes)
  const custom = settings.customThemes.map(customToDef)

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (t: ThemeDef) => !q || t.label.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
    return [
      { title: 'Follow light / dark', themes: BUILTIN_THEMES.filter(match) },
      { title: 'Your themes', themes: custom.filter(match) },
      { title: 'Dark', themes: PAINTED_THEMES.filter((t) => t.scheme === 'dark' && match(t)) },
      { title: 'Light', themes: PAINTED_THEMES.filter((t) => t.scheme === 'light' && match(t)) }
    ].filter((g) => g.themes.length)
  }, [filter, custom])

  const createCustom = () => {
    const scheme = resolveScheme(current, settings.appearance, systemDark)
    const p = previewOf(current, scheme, systemAccent)
    const theme: CustomTheme = {
      id: uid(),
      name: `${current.label} (custom)`,
      scheme,
      monospaced: !!current.monospaced,
      accent: p.accent.slice(0, 7).toUpperCase(),
      secondary: p.secondary.slice(0, 7).toUpperCase(),
      window: p.window,
      list: p.list,
      surface: p.surface,
      stroke: p.stroke,
      card: p.card,
      foreground: current.foreground ?? null
    }
    update({ customThemes: [...settings.customThemes, theme], themeId: `custom:${theme.id}` })
  }

  const editing = settings.customThemes.find((t) => `custom:${t.id}` === settings.themeId)

  return (
    <div className="appearance">
      <div className="appearance-bar">
        <div className="seg" title={current.scheme ? 'This theme sets light or dark itself.' : 'Follow the OS, or override it.'}>
          {(['system', 'light', 'dark'] as Appearance[]).map((a) => (
            <button
              key={a}
              className={settings.appearance === a ? 'active' : ''}
              disabled={!!current.scheme}
              onClick={() => update({ appearance: a })}
            >
              {a[0].toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
        <div className="panel-search inline">
          <Search size={13} />
          <input placeholder="Filter themes" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn secondary small" onClick={createCustom} title="Start a custom theme from the current one">
          {editing ? <Copy size={13} /> : <Plus size={13} />} {editing ? 'Duplicate' : 'Customize'}
        </button>
      </div>
      {current.scheme && (
        <p className="hint">
          “{current.label}” is always {current.scheme}, so the System / Light / Dark switch doesn’t apply to it.
        </p>
      )}

      {editing && <CustomThemeEditor theme={editing} />}

      {groups.map((g) => (
        <section key={g.title} className="theme-group">
          <h4>{g.title}</h4>
          <div className="theme-grid">
            {g.themes.map((t) => {
              const scheme = resolveScheme(t, settings.appearance, systemDark)
              const summary =
                t.id === 'system' && !systemAccent
                  ? 'Your OS doesn’t share an accent colour, so this uses FlosForge teal.'
                  : t.summary
              return (
                <ThemeSwatch
                  key={t.id}
                  theme={t}
                  summary={summary}
                  preview={previewOf(t, scheme, systemAccent)}
                  selected={t.id === current.id}
                  onSelect={() => update({ themeId: t.id })}
                />
              )
            })}
          </div>
        </section>
      ))}
      {!groups.length && <p className="hint">No theme matches “{filter}”.</p>}
    </div>
  )
}

/** A theme previewed as what it changes: a window with a rail, a list, a selected row, a button and a chip. */
function ThemeSwatch({
  theme,
  summary,
  preview: p,
  selected,
  onSelect
}: {
  theme: ThemeDef
  summary: string
  preview: Preview
  selected: boolean
  onSelect: () => void
}) {
  const font = theme.monospaced ? 'var(--font-mono)' : 'var(--font-ui)'
  return (
    <button className={`theme-swatch-card ${selected ? 'selected' : ''}`} onClick={onSelect} title={summary}>
      <div className="theme-preview" style={{ background: p.window, borderColor: p.stroke }}>
        <div className="tp-rail" style={{ background: p.window, borderColor: p.stroke }}>
          <span style={{ background: p.accent }} />
          <span style={{ background: p.stroke }} />
          <span style={{ background: p.stroke }} />
        </div>
        <div className="tp-main" style={{ background: p.list, borderColor: p.stroke }}>
          <div className="tp-row selected" style={{ background: `${p.accent}33` }}>
            <i style={{ background: p.accent }} />
            <b style={{ background: p.ink, opacity: 0.85 }} />
          </div>
          <div className="tp-row">
            <i style={{ background: p.secondary }} />
            <b style={{ background: p.ink, opacity: 0.45 }} />
          </div>
          <div className="tp-chips">
            <span style={{ background: p.accent, color: contrastInk(p.accent.slice(0, 7)), fontFamily: font }}>Send</span>
            <span style={{ background: p.surface, color: p.ink, borderColor: p.stroke, fontFamily: font }}>200</span>
          </div>
        </div>
      </div>
      <div className="theme-label" style={{ fontFamily: font }}>
        {theme.label}
      </div>
      <div className="theme-summary">{summary}</div>
    </button>
  )
}

const FIELDS: { key: keyof CustomTheme; label: string }[] = [
  { key: 'accent', label: 'Accent' },
  { key: 'secondary', label: 'Second accent' },
  { key: 'window', label: 'Window' },
  { key: 'list', label: 'Panels' },
  { key: 'surface', label: 'Inputs' },
  { key: 'stroke', label: 'Borders' },
  { key: 'card', label: 'Cards' }
]

function CustomThemeEditor({ theme }: { theme: CustomTheme }) {
  const settings = useWorkspace((s) => s.settings)
  const update = useWorkspace((s) => s.updateSettings)
  const set = (patch: Partial<CustomTheme>) =>
    update({ customThemes: settings.customThemes.map((t) => (t.id === theme.id ? { ...t, ...patch } : t)) })

  const remove = async () => {
    const ok = await confirm({ title: 'Delete theme?', message: `“${theme.name}” will be removed.`, confirmLabel: 'Delete', danger: true })
    if (ok !== true) return
    update({
      customThemes: settings.customThemes.filter((t) => t.id !== theme.id),
      themeId: BUILTIN_THEMES[0].id
    })
  }

  return (
    <div className="custom-theme-editor">
      <div className="cte-head">
        <input className="text-input" value={theme.name} onChange={(e) => set({ name: e.target.value })} />
        <div className="seg">
          <button className={theme.scheme === 'dark' ? 'active' : ''} onClick={() => set({ scheme: 'dark' })}>
            Dark
          </button>
          <button className={theme.scheme === 'light' ? 'active' : ''} onClick={() => set({ scheme: 'light' })}>
            Light
          </button>
        </div>
        <Toggle checked={theme.monospaced} onChange={(v) => set({ monospaced: v })} label="Monospace UI" />
        <button className="icon-btn" onClick={() => void remove()} title="Delete this theme">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="cte-colors">
        {FIELDS.map((f) => (
          <ColorField key={f.key} label={f.label} value={theme[f.key] as string} onChange={(v) => set({ [f.key]: v })} />
        ))}
        <div className="color-field">
          <label className="check-label small">
            <input
              type="checkbox"
              checked={theme.foreground !== null}
              onChange={(e) => set({ foreground: e.target.checked ? BRAND_ACCENT.dark : null })}
            />
            Tint all text
          </label>
          {theme.foreground !== null && <input type="color" value={theme.foreground} onChange={(e) => set({ foreground: e.target.value.toUpperCase() })} />}
        </div>
      </div>
      <p className="hint">Changes apply live and are saved with your settings. Colours are stored as #RRGGBB, so themes are easy to share.</p>
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <span>
        <span className="small">{label}</span>
        <code className="small">{value}</code>
      </span>
    </label>
  )
}
