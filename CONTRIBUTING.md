# Contributing

This project deliberately adapts small pieces of permissively licensed upstream telemetry SDKs. Never paste upstream code without recording its repository, exact commit, source path, license, and local modifications in `UPSTREAM.yml` and the destination file header.

## Checks

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Run `pnpm changeset` for user-visible changes.

## Updating an upstream

1. Update one upstream family at a time.
2. Record the new immutable commit in `UPSTREAM.yml`.
3. Preserve applicable copyright, license, and NOTICE text.
4. Run all package and fixture tests.
5. Confirm redaction and bundle boundaries before publishing.

