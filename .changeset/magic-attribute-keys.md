---
"@davidilie/telemetry-core": patch
"@davidilie/telemetry-web": patch
"@davidilie/telemetry-node": patch
"@davidilie/telemetry-react-native": patch
---

Drop `__proto__`, `constructor`, and `prototype` attribute keys during sanitization instead of bracket-assigning them onto plain objects, and check attribute presence with `Object.hasOwn` so dropped magic keys can no longer resolve through the prototype chain. Every sanitized attribute map stays a plain data object with an untouched prototype across all adapters.
