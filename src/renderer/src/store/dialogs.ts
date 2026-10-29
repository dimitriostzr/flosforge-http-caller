import { create } from 'zustand'

export interface PromptOptions {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  /** Adds a third button; resolves with 'alt' when clicked. */
  altLabel?: string
}

export type ModalName = 'import' | 'settings' | 'codegen' | 'cookies' | 'saveAs' | 'workspace' | 'variable'

export interface AskVariablesOptions {
  names: string[]
  /** Labels for the persistent targets that are available (missing = not offered). */
  environmentName?: string
  collectionName?: string
}

/** `once`: use for this send only. Otherwise the values are also saved to that target. */
export type AskVariablesTarget = 'once' | 'tab' | 'environment' | 'collection' | 'globals'
export type AskVariablesAnswer =
  | { action: 'send'; values: Record<string, string>; target: AskVariablesTarget }
  | { action: 'skip' }
  | null

type Pending =
  | { kind: 'prompt'; id: number; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'variables'; id: number; opts: AskVariablesOptions; resolve: (v: AskVariablesAnswer) => void }
  | { kind: 'confirm'; id: number; opts: ConfirmOptions; resolve: (v: boolean | 'alt') => void }

interface DialogState {
  pending: Pending | null
  modal: { name: ModalName; props?: Record<string, unknown> } | null
  toast: { id: number; message: string; tone: 'info' | 'error' | 'success' } | null
  openModal(name: ModalName, props?: Record<string, unknown>): void
  closeModal(): void
  close(): void
}

export const useDialogs = create<DialogState>()((set) => ({
  pending: null,
  modal: null,
  toast: null,
  openModal: (name, props) => set({ modal: { name, props } }),
  closeModal: () => set({ modal: null }),
  close: () => set({ pending: null })
}))

let dialogSeq = 0

export function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialogs.setState({ pending: { kind: 'prompt', id: ++dialogSeq, opts, resolve } }))
}

export function confirm(opts: ConfirmOptions): Promise<boolean | 'alt'> {
  return new Promise((resolve) => useDialogs.setState({ pending: { kind: 'confirm', id: ++dialogSeq, opts, resolve } }))
}

export function askVariables(opts: AskVariablesOptions): Promise<AskVariablesAnswer> {
  return new Promise((resolve) => useDialogs.setState({ pending: { kind: 'variables', id: ++dialogSeq, opts, resolve } }))
}

let toastSeq = 0
export function toast(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  const id = ++toastSeq
  useDialogs.setState({ toast: { id, message, tone } })
  setTimeout(() => {
    if (useDialogs.getState().toast?.id === id) useDialogs.setState({ toast: null })
  }, tone === 'error' ? 6000 : 3000)
}
