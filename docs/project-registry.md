# Project registry

The SDK contains no production DavidApps domains or routing keys. Hostnames,
origins, public keys, quotas, signal policy, owners, and dashboards live in the
GitOps repositories so they can change without republishing npm packages.

```yaml
projects:
  - id: example
    hosts:
      - random-project.telemetry.example
    allowedOrigins:
      - https://example.com
      - https://www.example.com
    publicKey: public-rotatable-routing-id
    ratePerSecond: 20
    burst: 40
    allowFaro: true
    allowTraces: true
    allowLogs: false
    allowMetrics: false
```

Applications use the same stable ID as nested resource metadata:

```ts
resource: {
  serviceName: "example-web",
  serviceVersion: deployedSha,
  commitSha: deployedSha,
  attributes: {
    "davidapps.project.id": "example",
  },
}
```

Do not place `davidapps.project.id` at the top level of `resource`; it belongs
under `attributes`.

## Registry fields

| Field | Contract |
| --- | --- |
| `id` | Stable, low-cardinality project/dashboard routing ID |
| `hosts` | Exact public hostnames owned by the project |
| `allowedOrigins` | Exact browser scheme/host origins; no wildcard semantics |
| `publicKey` | Optional rotatable public routing identifier sent as `x-api-key` |
| `ratePerSecond` / `burst` | Token-bucket policy per gateway process/replica |
| `allowFaro` | Permit `POST /collect`; defaults to true |
| `allowTraces` | Permit `POST /v1/traces`; defaults to true |
| `allowLogs` | Permit `POST /v1/logs`; defaults to false |
| `allowMetrics` | Permit `POST /v1/metrics`; defaults to false |

Browser clients use `https://<host>/collect`. Mobile trace clients use
`https://<host>/v1/traces` (the React Native adapter appends it to a base URL).
In-cluster servers should export to private Alloy and do not need a registry
key.

## Threat model

The randomized host and public key are present in browser/mobile code. They are
not secrets or proof of project/user identity. A non-browser client can omit or
forge `Origin`, replay the key, and forge resource fields inside the payload.
The gateway uses the registry to route and bound abuse; it does not transform
the payload into authenticated telemetry.

Rotate a key or hostname when useful for noise control, not as incident
containment for a leaked credential. Use private, workload-authenticated paths
for sensitive server signals and an application database/audit log for trusted
business facts.

## Change protocol

1. Add/change the project in the gateway's GitOps values.
2. Render and validate the Helm/Kustomize output.
3. Reconcile the cluster and verify all gateway replicas are ready.
4. Test preflight, rejection, rate, and successful forwarding.
5. Update the application public configuration.
6. Verify the resulting signal in its final backend and dashboard.
7. Remove an old route only after the deployed client population no longer uses
   it, especially for mobile releases that upgrade slowly.

Never paste production routing tables into an npm package README. The current
operator registry belongs in the private/public-as-intended GitOps source of
truth.
