// SPDX-License-Identifier: Apache-2.0

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Attributes, TelemetryClient } from "@davidapps/telemetry-core";

export interface TelemetryErrorBoundaryFallbackProps {
  error: Error;
  reset(): void;
}

export interface TelemetryErrorBoundaryProps {
  client: TelemetryClient;
  children: ReactNode;
  attributes?: Attributes;
  fallback?: ReactNode | ((props: TelemetryErrorBoundaryFallbackProps) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
}

interface TelemetryErrorBoundaryState {
  error: Error | null;
}

function resetKeysChanged(previous: readonly unknown[] = [], next: readonly unknown[] = []): boolean {
  return previous.length !== next.length || previous.some((value, index) => !Object.is(value, next[index]));
}

export class TelemetryErrorBoundary extends Component<
  TelemetryErrorBoundaryProps,
  TelemetryErrorBoundaryState
> {
  state: TelemetryErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): TelemetryErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.client.captureException(error, {
      ...this.props.attributes,
      "error.react_boundary": true,
      ...(info.componentStack ? { "react.component_stack": info.componentStack } : {}),
    });
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps: TelemetryErrorBoundaryProps): void {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (typeof this.props.fallback === "function") {
      return this.props.fallback({ error, reset: this.reset });
    }
    return this.props.fallback ?? null;
  }
}
