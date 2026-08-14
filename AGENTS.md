# Agent protocol

This repository is intentionally small and specific to the DavidApps observability stack. Preserve that constraint.

## Architecture

- Put runtime-neutral event shapes, redaction, sampling, hooks, and the public client API in `packages/core`.
- Keep `web`, `node`, `next`, and `react-native` as thin runtime adapters. Do not fork the public API per runtime.
- Use standard Grafana Faro and OpenTelemetry protocols. Do not invent a DavidApps wire format.
- Browser and mobile traffic goes through the public ingest gateway. Server traffic exports OTLP directly to Alloy.
- Alloy routes data to Tempo, VictoriaLogs, and Prometheus. The gateway never stores telemetry.

## Adding or changing an adapter

1. Start from a maintained upstream package or specification when one already solves the transport problem.
2. Record the upstream repository, exact commit, license, and whether it is a dependency or adaptation in `UPSTREAM.yml`.
3. Preserve upstream file headers and notices for copied or adapted code. Update `THIRD_PARTY_NOTICES.md` when attribution changes.
4. Translate runtime-specific signals into the core API; do not leak vendor-specific objects through the default export.
5. Keep browser, Edge, Node, and React Native entrypoints import-safe for their declared runtimes.
6. Add a fixture and a focused test for any new runtime behavior.

## Adding a project

Follow `docs/adding-a-project.md`. Every integration must set `service.name`, `service.version` to the deployed commit SHA, `deployment.environment.name`, and `davidapps.project.id`. Never put an ingest credential or secret in a browser/mobile bundle; the public routing key is not authentication.

## Guardrails

- Redact secrets and direct identifiers before export. Avoid request/response bodies by default.
- Keep event names stable and low-cardinality. Do not put user IDs, URLs, trace IDs, or error messages in metric labels.
- No session replay, feature flags, experiments, DOM autocapture, product warehouse, or persistent gateway storage.
- Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm licenses:check` before release.
- Do not change cluster manifests from this repository. The GitOps repositories own domains, project routing, quotas, dashboards, and retention.

