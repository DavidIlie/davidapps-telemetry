# DavidApps Telemetry Gateway

Small stateless ingress guard in front of Grafana Alloy. It binds owned hostnames to configured projects, enforces browser origins, public write keys, quotas, and payload sizes, and proxies accepted Faro/OTLP requests to private Alloy receivers.

Public write keys and randomized hostnames are routing identifiers, not secrets.
