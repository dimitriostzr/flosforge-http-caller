import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { activeWorkspace, useWorkspace } from '../store/workspace'
import { applyTheme, findTheme } from './apply'

// --- OS signals, as tiny external stores -----------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const subscribeDark = (cb: () => void): (() => void) => {
  darkQuery.addEventListener('change', cb)
  return () => darkQuery.removeEventListener('change', cb)
}
export const useSystemDark = (): boolean => useSyncExternalStore(subscribeDark, () => darkQuery.matches)

let systemAccent: string | null = null
const accentListeners = new Set<() => void>()
async function refreshAccent(): Promise<void> {
  const next = await window.api.systemAccent().catch(() => null)
  if (next === systemAccent) return
  systemAccent = next
  accentListeners.forEach((l) => l())
}
void refreshAccent()
// The OS accent can change while we run; re-read it whenever the window regains focus.
window.addEventListener('focus', () => void refreshAccent())
export const useSystemAccent = (): string | null =>
  useSyncExternalStore(
    (cb) => {
      accentListeners.add(cb)
      return () => accentListeners.delete(cb)
    },
    () => systemAccent
  )

/** Applies the active theme + workspace colour to the document. Mounted once, in App. */
export function useThemeEffect(): void {
  const appearance = useWorkspace((s) => s.settings.appearance)
  const themeId = useWorkspace((s) => s.settings.themeId)
  const customThemes = useWorkspace((s) => s.settings.customThemes)
  const workspace = useWorkspace(activeWorkspace)
  const systemDark = useSystemDark()
  const accent = useSystemAccent()
  const theme = useMemo(() => findTheme(themeId, customThemes), [themeId, customThemes])
  const workspaceColor = workspace?.color ?? null

  useEffect(() => {
    applyTheme({ theme, appearance, systemDark, systemAccent: accent, workspaceColor })
    // Native chrome follows too. A theme with a fixed scheme forces it; otherwise
    // hand the user's preference through ("system" keeps prefers-color-scheme live).
    void window.api.setScheme(theme.scheme ?? appearance)
    const { bg, ink } = resolvedChromeColors()
    void window.api.setTitleBarColors(bg, ink)
  }, [theme, appearance, systemDark, accent, workspaceColor])
}

/**
 * The title bar's background and text colour as #rrggbb. Theme tokens can be
 * color-mix() expressions, so let the browser resolve them on a probe element.
 */
function resolvedChromeColors(): { bg: string; ink: string } {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--bg);color:var(--text-muted)'
  document.body.append(probe)
  const cs = getComputedStyle(probe)
  const toHex = (c: string): string => {
    // rgb(r, g, b) uses 0-255; color(srgb r g b), which color-mix() produces, uses 0-1.
    const scale = c.startsWith('color(') ? 255 : 1
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
    return '#' + m.slice(0, 3).map((n) => Math.min(255, Math.round(n * scale)).toString(16).padStart(2, '0')).join('')
  }
  const out = { bg: toHex(cs.backgroundColor), ink: toHex(cs.color) }
  probe.remove()
  return out
}
