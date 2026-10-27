import { Component, type ReactNode } from "react";

/** The UI must never show a broken state: a render error shows a calm fallback with a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error(err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="fallback">
        <div className="kicker">{this.props.label ?? "view"} paused</div>
        <p>This view hit an unexpected state. The run itself is unaffected.</p>
        <button className="btn" onClick={() => { this.setState({ err: null }); location.hash = "#/"; }}>Back to scenarios</button>
      </div>
    );
  }
}
