import { useState } from "react";
import { telemetry } from "./telemetry.js";

export function App() {
  const [count, setCount] = useState(0);

  function captureClick() {
    const next = count + 1;
    setCount(next);
    telemetry?.capture("fixture.button.clicked", { count: next });
  }

  function captureError() {
    try {
      throw new Error("Intentional fixture error");
    } catch (error) {
      telemetry?.captureException(error, { source: "fixture.button" });
    }
  }

  return (
    <main>
      <h1>DavidApps web telemetry fixture</h1>
      <p>
        Telemetry is {telemetry ? "enabled" : "disabled"}. It is disabled by
        default and only starts when both VITE_TELEMETRY_ENABLED=true and an
        ingest URL are present.
      </p>
      <button onClick={captureClick}>Capture click ({count})</button>
      <button onClick={captureError}>Capture handled error</button>
    </main>
  );
}
