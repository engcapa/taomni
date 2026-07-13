import "./lib/webviewCompat";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

interface RootErrorBoundaryState {
  error: unknown;
  componentStack: string;
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { error, componentStack: "" };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const componentStack = info.componentStack ?? "";
    console.error("[ui] React render failed", error, componentStack);
    this.setState({ componentStack });
  }

  render() {
    if (this.state.error) {
      return (
        <AppCrash
          error={this.state.error}
          componentStack={this.state.componentStack}
          phase="ui"
        />
      );
    }
    return this.props.children;
  }
}

function AppCrash({
  error,
  componentStack = "",
  phase,
}: {
  error: unknown;
  componentStack?: string;
  phase: "startup" | "ui";
}) {
  const message = error instanceof Error ? error.message : String(error);
  const report = componentStack ? `${message}\n\n--- React component stack ---\n${componentStack}` : message;
  const startup = phase === "startup";

  return (
    <div
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        padding: 24,
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        background: "#ffffff",
        color: "#1f2328",
      }}
    >
      <div style={{ maxWidth: 760 }}>
        <h1 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 700 }}>
          {startup ? "Taomni failed to start" : "Taomni UI encountered an error"}
        </h1>
        <p style={{ margin: "0 0 16px", color: "#59636e", fontSize: 13, lineHeight: 1.5 }}>
          {startup
            ? "The app failed while loading in this WebView. Please include the details below when reporting it."
            : "The app hit a React UI error in this WebView. Please include the details below when reporting it."}
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            border: "1px solid #d0d7de",
            borderRadius: 6,
            background: "#f6f8fa",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {report}
        </pre>
      </div>
    </div>
  );
}

function renderStartupCrash(error: unknown): void {
  console.error("[startup] App module failed to load", error);
  ReactDOM.createRoot(document.getElementById("root")!).render(<AppCrash error={error} phase="startup" />);
}

async function bootstrap(): Promise<void> {
  const { default: App } = await import("./App");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap().catch(renderStartupCrash);
