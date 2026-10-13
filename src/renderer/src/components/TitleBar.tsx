import { useEffect } from 'react'
import { Menu } from 'lucide-react'
import { APP_NAME, TITLEBAR_HEIGHT } from '@shared/app'
import { activeWorkspace, useWorkspace } from '../store/workspace'
import { LogoMark } from './sidebar/Sidebar'

const platform = window.api.platform
const isMac = platform === 'darwin'

/** The window title, shown in this bar and given to the OS (taskbar, window switcher): always identical. */
export function useWindowTitle(): string {
  const name = useWorkspace((s) => activeWorkspace(s)?.name)
  return name ? `${name} — ${APP_NAME}` : APP_NAME
}

/**
 * Replaces the native title bar so the top of the window matches the theme.
 * macOS: the traffic lights sit at its left, so content starts after them.
 * Windows/Linux: the OS draws its controls over the right end (window controls
 * overlay); the CSS titlebar-area env() values keep content out from under them.
 */
export function TitleBar() {
  const title = useWindowTitle()
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <header className={`titlebar ${isMac ? 'mac' : 'overlay'}`} style={{ height: TITLEBAR_HEIGHT }}>
      <div className="titlebar-left">
        {!isMac && (
          <button
            className="titlebar-btn"
            title="Menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              void window.api.popupAppMenu(r.left, r.bottom)
            }}
          >
            <Menu size={16} />
          </button>
        )}
        <span className="titlebar-brand">
          <LogoMark size={18} />
        </span>
      </div>
      <div className="titlebar-title">{title}</div>
    </header>
  )
}
