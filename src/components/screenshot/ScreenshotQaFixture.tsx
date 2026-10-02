import { useEffect, useState } from "react";

/**
 * Content shown in the native QA fixture window (`screenshot-qa-fixture`),
 * opened only by the isolated QA app's screenshot scenarios.
 *
 * - `scroll`: a tall list whose rows encode their index in the background
 *   color (R = 30 + (i % 8) * 28, G = 30 + floor(i / 8) * 28, B = 210), so a
 *   stitched long screenshot can be decoded row by row.
 * - `anim`: a moving block and changing stripes so recordings have motion.
 */
export function ScreenshotQaFixture({ route }: { route: string }) {
  if (route === "anim") return <AnimFixture />;
  if (route === "ocr") return <OcrFixture />;
  return <ScrollFixture />;
}

const ROWS = 64;

function rowColor(i: number): string {
  return `rgb(${30 + (i % 8) * 28}, ${30 + Math.floor(i / 8) * 28}, 210)`;
}

function ScrollFixture() {
  return (
    <div
      data-testid="screenshot-qa-fixture-ready"
      style={{ position: "fixed", inset: 0, overflowY: "scroll", background: "#ffffff", scrollBehavior: "auto" }}
    >
      {Array.from({ length: ROWS }, (_, i) => (
        <div
          key={i}
          style={{
            height: 44,
            marginBottom: 4,
            background: rowColor(i),
            color: "#ffffff",
            font: "600 14px sans-serif",
            display: "flex",
            alignItems: "center",
            paddingLeft: 12,
          }}
        >
          {/* Text stays left so the decode column (x = 3/4 width) is flat. */}
          Row {i}
        </div>
      ))}
    </div>
  );
}

function OcrFixture() {
  return (
    <div data-testid="screenshot-qa-fixture-ready" style={{ position: "fixed", inset: 0, background: "#ffffff", color: "#000000", padding: 24, font: "28px Arial, sans-serif" }}>
      <p style={{ margin: "12px 0 28px" }}>QA screenshot text</p>
      <p style={{ margin: "12px 0 28px" }}>user@example.com</p>
      <p style={{ margin: "12px 0 28px" }}>13812345678</p>
      <p style={{ margin: "12px 0 28px" }}>2026-10-02</p>
    </div>
  );
}

function AnimFixture() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 50);
    return () => window.clearInterval(id);
  }, []);
  const x = (tick * 9) % 400;
  return (
    <div
      data-testid="screenshot-qa-fixture-ready"
      style={{ position: "fixed", inset: 0, background: `hsl(${(tick * 4) % 360}, 45%, 30%)`, overflow: "hidden" }}
    >
      <div style={{ position: "absolute", left: x, top: 150, width: 80, height: 80, background: "#ff3030", borderRadius: 8 }} />
      <div
        style={{
          position: "absolute",
          left: 20,
          top: 20,
          color: "#ffffff",
          font: "700 28px monospace",
        }}
      >
        frame {tick}
      </div>
    </div>
  );
}
