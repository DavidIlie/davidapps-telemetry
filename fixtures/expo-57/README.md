# Expo 57 fixture

Exercises the pure-JavaScript telemetry adapter against Expo 57 and React Native 0.86.2.

```sh
EXPO_PUBLIC_TELEMETRY_ENDPOINT=https://project.telemetry.example pnpm start
```

Without the environment variable the UI runs, but telemetry export remains disabled. `localhost` from a physical device is not the development computer; use a reachable ingest hostname for an end-to-end test.
