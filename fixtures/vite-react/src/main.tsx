import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  reportReactError,
  TelemetryErrorBoundary,
} from "@davidapps/telemetry-web/react";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root, {
  onUncaughtError: reportReactError,
  onRecoverableError: reportReactError,
}).render(
  <StrictMode>
    <TelemetryErrorBoundary>
      <App />
    </TelemetryErrorBoundary>
  </StrictMode>,
);
