import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Where this boundary sits, shown in the message ("the request editor"). */
  area: string
}

/**
 * Contains a rendering crash to one part of the window. Without this, any error
 * while rendering unmounts the whole app and leaves a blank window.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Crash in ${this.props.area}:`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <AlertTriangle size={28} strokeWidth={1.5} />
        <div className="crash-title">Something went wrong in {this.props.area}</div>
        <pre className="crash-message">{error.message}</pre>
        <p className="hint">Your saved data is safe. Try again, or reload the window if it keeps happening.</p>
        <div className="row-gap">
          <button className="btn primary small" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn secondary small" onClick={() => location.reload()}>
            Reload window
          </button>
        </div>
      </div>
    )
  }
}
