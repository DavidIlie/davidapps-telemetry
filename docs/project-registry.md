# Project registry

The SDK contains no DavidApps domains. Deployment-specific hostnames, origins, routing keys, quotas, and signal permissions live in the Helm values committed to the target GitOps repository.

Each project has stable first-party hosts. A public key or randomized path is a routing identifier visible to browsers and mobile applications, not an authentication secret.

```yaml
projects:
  - id: zerocut
    hosts: [e.zerocut.gg]
    allowedOrigins: [https://zerocut.gg, https://www.zerocut.gg]
    publicKey: public-rotatable-routing-id
    ratePerSecond: 20
    burst: 40
    allowFaro: true
    allowTraces: false
```

In-cluster server applications bypass the public gateway and export OTLP directly to Alloy.

