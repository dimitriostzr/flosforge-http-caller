import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { create } from 'zustand'

export function MethodBadge({ method, short }: { method: string; short?: boolean }) {
  const m = method.toUpperCase()
  const label = short ? ({ DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' } as Record<string, string>)[m] ?? m : m
  return <span className={`method method-${m.toLowerCase()}`}>{label}</span>
}

export interface TabDef<T extends string> {
  id: T
  label: ReactNode
  badge?: ReactNode
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  right,
  className
}: {
  tabs: TabDef<T>[]
  value: T
  onChange: (v: T) => void
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={`subtabs ${className ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          className={`subtab ${t.id === value ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="subtab-badge">{t.badge}</span>}
        </button>
      ))}
      <div className="subtabs-spacer" />
      {right}
    </div>
  )
}

/** Drag handle. Calls onDrag with the pointer delta (px) since drag start. */
export function Splitter({
  direction,
  onDrag,
  onStart,
  onEnd
}: {
  direction: 'horizontal' | 'vertical'
  onDrag: (delta: number, start: { x: number; y: number }) => void
  onStart?: () => void
  onEnd?: () => void
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    onStart?.()
    const start = { x: e.clientX, y: e.clientY }
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    document.body.classList.add(direction === 'vertical' ? 'resizing-col' : 'resizing-row')
    const move = (ev: PointerEvent) =>
      onDrag(direction === 'vertical' ? ev.clientX - start.x : ev.clientY - start.y, start)
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-col', 'resizing-row')
      onEnd?.()
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }
  return <div className={`splitter splitter-${direction}`} onPointerDown={onPointerDown} />
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  className
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={{ width }} role="dialog" aria-modal>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  )
}

/** Input that commits on blur/Enter instead of every keystroke; Escape reverts. */
export function InlineEdit({
  value,
  onCommit,
  onCancel,
  className,
  autoFocus = true,
  selectAll = true
}: {
  value: string
  onCommit: (v: string) => void
  onCancel?: () => void
  className?: string
  autoFocus?: boolean
  selectAll?: boolean
}) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus()
      if (selectAll) ref.current?.select()
    }
  }, [autoFocus, selectAll])
  const commit = () => {
    if (done.current) return
    done.current = true
    const t = v.trim()
    if (t && t !== value) onCommit(t)
    else onCancel?.()
  }
  return (
    <input
      ref={ref}
      className={`inline-edit ${className ?? ''}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          done.current = true
          onCancel?.()
        }
      }}
    />
  )
}

// --- Context menu -------------------------------------------------------------

export type MenuItem =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | { separator: true }

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
  show(x: number, y: number, items: MenuItem[]): void
  hide(): void
}

export const useMenu = create<MenuState>()((set) => ({
  menu: null,
  show: (x, y, items) => set({ menu: { x, y, items } }),
  hide: () => set({ menu: null })
}))

export function openMenu(e: React.MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // Clicked via a button: anchor below it. Right-click: at the pointer.
  const fromButton = e.type === 'click'
  useMenu.getState().show(fromButton ? rect.left : e.clientX, fromButton ? rect.bottom + 4 : e.clientY, items)
}

export function ContextMenuHost() {
  const { menu, hide } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return setPos(null)
    const el = ref.current
    if (!el) return
    const { innerWidth: w, innerHeight: h } = window
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, w - r.width - 8), y: Math.min(menu.y, h - r.height - 8) })
  }, [menu])

  const close = useCallback(() => hide(), [hide])
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])

  if (!menu) return null
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      role="menu"
    >
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              close()
              it.onClick()
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
export const modKey = isMac ? '⌘' : 'Ctrl'
