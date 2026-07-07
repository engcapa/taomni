import "./lib/webviewCompat";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

interface RootErrorBoundaryState {
  error: unknown;
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[startup] React render failed", error);
  }

  render() {
    if (this.state.error) {
      return <StartupCrash error={this.state.error} />;
    }
    return this.props.children;
  }
}

function StartupCrash({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

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
        <h1 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 700 }}>Taomni failed to start</h1>
        <p style={{ margin: "0 0 16px", color: "#59636e", fontSize: 13, lineHeight: 1.5 }}>
          The app hit a startup error in this WebView. Please include the details below when reporting it.
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
          {message}
        </pre>
      </div>
    </div>
  );
}

function renderStartupCrash(error: unknown): void {
  console.error("[startup] App module failed to load", error);
  ReactDOM.createRoot(document.getElementById("root")!).render(<StartupCrash error={error} />);
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
