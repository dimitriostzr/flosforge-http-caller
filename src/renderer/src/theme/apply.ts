import type { Appearance, CustomTheme } from '@shared/types'
import { BUILTIN_THEMES, PAINTED_THEMES, type ThemeDef } from './themes'

// One place resolves the theme and writes it to the document as CSS custom
// properties. styles.css holds the hand-tuned tokens for the built-in themes;
// painted themes override the surface/text/syntax tokens inline on <html>.
// Accent-derived tokens (hover, tints, borders) are color-mix()es in styles.css,
// so setting --accent is enough to recolour everything that hangs off it.

/** FlosForge teal, per scheme (from the brand tokens). */
export const BRAND_ACCENT = { dark: '#2DD4BF', light: '#0E7490' } as const

export const ALL_THEMES: ThemeDef[] = [...BUILTIN_THEMES, ...PAINTED_THEMES]

export function customToDef(t: CustomTheme): ThemeDef {
  return {
    id: `custom:${t.id}`,
    label: t.name,
    summary: 'Your own theme.',
    scheme: t.scheme,
    accent: t.accent,
    secondary: t.secondary,
    window: t.window,
    list: t.list,
    surface: t.surface,
    stroke: t.stroke,
    card: t.card,
    selection: `${t.accent}38`,
    foreground: t.foreground ?? undefined,
    monospaced: t.monospaced
  }
}

export function findTheme(id: string, custom: CustomTheme[]): ThemeDef {
  if (id.startsWith('custom:')) {
    const t = custom.find((c) => `custom:${c.id}` === id)
    if (t) return customToDef(t)
  }
  return ALL_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0]
}

export const isPainted = (t: ThemeDef): boolean => !!t.window

export function resolveScheme(t: ThemeDef, appearance: Appearance, systemDark: boolean): 'dark' | 'light' {
  if (t.scheme) return t.scheme
  if (appearance === 'system') return systemDark ? 'dark' : 'light'
  return appearance
}

/** The theme's own accent, before any workspace colour is applied. */
export function themeAccent(t: ThemeDef, scheme: 'dark' | 'light', systemAccent: string | null): string {
  if (t.accent) return t.accent
  if (t.id === 'system' && systemAccent) return systemAccent
  return BRAND_ACCENT[scheme]
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Black or white ink for text on `hex` (Rec. 601 luma, threshold 0.62, as in the Reader). */
export function contrastInk(hex: string): string {
  const [r, g, b] = rgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#0B0F14' : '#FFFFFF'
}

export const isHexColor = (s: string): boolean => /^#[0-9a-f]{6}$/i.test(s)

const DEFAULT_INK = { dark: '#E3E6EE', light: '#1A1E28' }

/** Every property a painted theme may set, so switching back clears them all. */
const PAINTED_PROPS = [
  '--bg',
  '--bg-elev',
  '--bg-elev-2',
  '--bg-hover',
  '--bg-active',
  '--border',
  '--border-strong',
  '--text',
  '--text-muted',
  '--text-faint',
  '--selection',
  '--active-line',
  '--syn-keyword',
  '--syn-string',
  '--syn-number',
  '--syn-property',
  '--syn-function',
  '--syn-tag',
  '--syn-comment',
  '--syn-punct',
  '--font-ui'
]

const mix = (a: string, b: string, pctB: number): string => `color-mix(in srgb, ${a}, ${b} ${pctB}%)`

/** Custom property values for a painted theme. Exported for the theme previews. */
export function paintedTokens(t: ThemeDef, scheme: 'dark' | 'light'): Record<string, string> {
  const ink = t.foreground ?? DEFAULT_INK[scheme]
  const out: Record<string, string> = {
    '--bg': t.window!,
    '--bg-elev': t.list!,
    '--bg-elev-2': t.surface!,
    '--bg-hover': mix(t.surface!, ink, 8),
    '--bg-active': mix(t.surface!, ink, 14),
    '--border': mix(t.stroke!, t.list!, 35),
    '--border-strong': t.stroke!,
    '--text': ink,
    '--text-muted': mix(ink, t.list!, 36),
    '--text-faint': mix(ink, t.list!, 56),
    '--selection': t.selection ?? `${t.accent}38`,
    '--active-line': mix(t.list!, ink, 4),
    '--syn-keyword': t.accent!,
    '--syn-property': t.secondary!
  }
  if (t.foreground) {
    // Single-phosphor themes: code is all one ink, in a few strengths.
    Object.assign(out, {
      '--syn-string': t.accent!,
      '--syn-number': t.secondary!,
      '--syn-function': ink,
      '--syn-tag': t.accent!,
      '--syn-comment': mix(ink, t.list!, 50),
      '--syn-punct': mix(ink, t.list!, 30)
    })
  }
  if (t.monospaced) out['--font-ui'] = 'var(--font-mono)'
  return out
}

export interface ThemeInput {
  theme: ThemeDef
  appearance: Appearance
  systemDark: boolean
  systemAccent: string | null
  /** The active workspace's colour; wins over the theme's accent when set. */
  workspaceColor: string | null
}

export function applyTheme({ theme, appearance, systemDark, systemAccent, workspaceColor }: ThemeInput): 'dark' | 'light' {
  const root = document.documentElement
  const scheme = resolveScheme(theme, appearance, systemDark)
  root.dataset.theme = scheme
  root.dataset.palette = isPainted(theme) ? 'painted' : 'builtin'

  for (const p of PAINTED_PROPS) root.style.removeProperty(p)
  if (isPainted(theme)) for (const [k, v] of Object.entries(paintedTokens(theme, scheme))) root.style.setProperty(k, v)

  const accent = workspaceColor && isHexColor(workspaceColor) ? workspaceColor : themeAccent(theme, scheme, systemAccent)
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-contrast', contrastInk(accent))
  return scheme
}
