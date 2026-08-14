// SPDX-License-Identifier: Apache-2.0

import Constants from "expo-constants";
import type { Attributes, TelemetryResource } from "@davidilie/telemetry-core";

type UnknownRecord = Record<string, unknown>;

export interface ExpoResourceOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  namespace?: string;
  repositoryUrl?: string;
  commitSha?: string;
  platform?: string;
  build?: string;
  updateId?: string;
  updateChannel?: string;
  runtimeVersion?: string;
  attributes?: Attributes;
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberString(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : string(value);
}

/** Creates stable OTel resource metadata without importing native Expo modules. */
export function createExpoTelemetryResource(options: ExpoResourceOptions = {}): TelemetryResource {
  const constants = Constants as unknown as UnknownRecord;
  const expoConfig = record(constants.expoConfig) ?? {};
  const ios = record(expoConfig.ios);
  const android = record(expoConfig.android);
  const runtimePlatform = record(constants.platform);
  const runtimeIos = record(runtimePlatform?.ios);
  const runtimeAndroid = record(runtimePlatform?.android);
  const extra = record(expoConfig.extra);
  const configuredPlatform = options.platform;
  const platform =
    configuredPlatform ??
    (runtimeIos ? "ios" : runtimeAndroid ? "android" : "react-native");
  const bundleId =
    platform === "ios"
      ? string(ios?.bundleIdentifier)
      : platform === "android"
        ? string(android?.package)
        : string(ios?.bundleIdentifier) ?? string(android?.package);
  const build =
    options.build ??
    (platform === "ios"
      ? numberString(runtimeIos?.buildNumber) ?? numberString(ios?.buildNumber)
      : platform === "android"
        ? numberString(runtimeAndroid?.versionCode) ?? numberString(android?.versionCode)
        : numberString(ios?.buildNumber) ?? numberString(android?.versionCode));
  const runtimeVersion =
    options.runtimeVersion ??
    string(constants.expoRuntimeVersion) ??
    string(expoConfig.runtimeVersion);
  const commitSha = options.commitSha ?? string(extra?.commitSha) ?? string(extra?.gitSha);
  const marketingVersion = string(expoConfig.version);
  // `service.version` is the deployed source revision across every DavidApps
  // runtime. Keep the store-facing version separately as `app.version`.
  const serviceVersion = options.serviceVersion ?? commitSha;

  return {
    serviceName: options.serviceName ?? string(expoConfig.slug) ?? string(expoConfig.name) ?? "expo-app",
    ...(serviceVersion ? { serviceVersion } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.repositoryUrl ? { repositoryUrl: options.repositoryUrl } : {}),
    ...(commitSha ? { commitSha } : {}),
    platform,
    attributes: {
      ...options.attributes,
      ...(marketingVersion ? { "app.version": marketingVersion } : {}),
      ...(bundleId ? { "app.bundle.id": bundleId } : {}),
      ...(build ? { "app.build": build } : {}),
      ...(options.updateId ? { "app.update.id": options.updateId } : {}),
      ...(options.updateChannel ? { "app.update.channel": options.updateChannel } : {}),
      ...(runtimeVersion ? { "app.runtime.version": runtimeVersion } : {}),
      ...(string(constants.executionEnvironment)
        ? { "expo.execution_environment": string(constants.executionEnvironment) }
        : {}),
    },
  };
}
