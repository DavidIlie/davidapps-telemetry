---
"@davidilie/telemetry-core": patch
"@davidilie/telemetry-node": patch
---

Drop `__proto__`, `constructor`, and `prototype` attribute keys during sanitization instead of bracket-assigning them onto plain objects. This keeps every sanitized attribute map a plain data object with an untouched prototype across all adapters.
