"use client";

import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { TelemetryClient } from "@davidilie/telemetry-core";
import {
  getWebTelemetryClient,
  initializeWebTelemetry,
  type WebTelemetry,
  type WebTelemetryConfig,
} from "./initialize.js";

export interface TelemetryProps {
  config: WebTelemetryConfig;
  onReady?: (telemetry: WebTelemetry) => void;
}

export function Telemetry({ config, onReady }: TelemetryProps): null {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    onReady?.(initializeWebTelemetry(config));
  }, [config, onReady]);

  return null;
}

export interface ReactErrorDetails {
  componentStack?: string | null | undefined;
}

export function reportReactError(
  error: unknown,
  details: ReactErrorDetails = {},
  client: TelemetryClient | undefined = getWebTelemetryClient(),
): void {
  client?.captureException(error, {
    ...(details.componentStack
      ? { "react.component_stack": details.componentStack }
      : {}),
  });
}

export interface TelemetryErrorBoundaryProps {
  children: ReactNode;
  client?: TelemetryClient;
  fallback?: ReactNode | ((error: unknown) => ReactNode);
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface TelemetryErrorBoundaryState {
  error: unknown;
  hasError: boolean;
}

export class TelemetryErrorBoundary extends Component<
  TelemetryErrorBoundaryProps,
  TelemetryErrorBoundaryState
> {
  state: TelemetryErrorBoundaryState = { error: undefined, hasError: false };

  static getDerivedStateFromError(error: unknown): TelemetryErrorBoundaryState {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportReactError(error, info, this.props.client);
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return typeof this.props.fallback === "function"
      ? this.props.fallback(this.state.error)
      : (this.props.fallback ?? null);
  }
}
