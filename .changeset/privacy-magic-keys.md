---
"@davidilie/telemetry-web": patch
"@davidilie/telemetry-react-native": patch
---

Harden the remaining object-rebuild loops against magic keys. The Faro transport-item sanitizer now drops `__proto__`/`constructor`/`prototype` keys at every depth instead of assigning them onto rebuilt plain objects (which triggered the legacy `__proto__` setter and let attacker-influenced payloads leak through the prototype chain to `beforeSendFaro` hooks). The React Native OTLP attribute converter gains the same forbidden-key guard the Node converter already had. No legitimate attribute or payload keys are affected.
