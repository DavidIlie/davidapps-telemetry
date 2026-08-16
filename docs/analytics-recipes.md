# Analytics recipes

These recipes turn the existing observability stores into useful product and
performance answers. They are intentionally not a PostHog clone: there is no
identity graph, cohort materialization, SQL warehouse, or precomputed funnel.
Queries operate on retained Faro logs, traces, and derived metrics.

Always state the service/project, environment, UTC range, sampling rate, and
release filter with the result. An empty query does not prove an event did not
happen; it can also indicate sampling, batching, retention, or a field mismatch.

## Discover the actual fields first

The DavidApps Alloy pipeline parses Faro logfmt into VictoriaLogs fields. Check
one canary before building a dashboard:

```logsql
collector:"alloy" app_name:"storefront-web"
| field_names
| sort by (_msg)
```

```logsql
collector:"alloy" app_name:"storefront-web" kind:"event"
| fields _time, kind, event_name, app_name, app_version, app_environment,
         page_url, session_id, trace_id, span_id
| sort by (_time desc)
| limit 20
```

Faro/Alloy upgrades can rename flattened context fields. `app_name`,
`app_version`, `kind`, and `event_name` are the expected current fields; verify
custom attribute and session field names from the canary rather than guessing.

## Page performance and Web Vitals

Faro emits Web Vitals as measurement records. A release-aware five-minute view:

```logsql
collector:"alloy" app_name:"storefront-web" kind:"measurement"
| stats by (_time:5m, app_version)
    quantile(0.75, lcp) if (lcp:*) as lcp_p75,
    quantile(0.75, cls) if (cls:*) as cls_p75,
    quantile(0.75, inp) if (inp:*) as inp_p75,
    quantile(0.75, fcp) if (fcp:*) as fcp_p75,
    quantile(0.75, ttfb) if (ttfb:*) as ttfb_p75
```

Not every page/browser produces every measurement. Conditional aggregations
prevent missing fields from entering the percentile. Break down by a bounded
route/template field when the application supplies one; avoid raw `page_url`
when it contains dynamic paths. Compare `app_version` values only after
confirming each is an exact deployed SHA.

For server/mobile operations, query Tempo-derived span metrics:

```promql
histogram_quantile(
  0.95,
  sum by (le, service, span_name) (
    rate(traces_spanmetrics_latency_bucket{service="storefront"}[5m])
  )
)
```

Mobile time-to-interactive is a trace span/measurement representation, not a
Prometheus metric in this release:

```traceql
{
  resource.service.name = "storefront-mobile" &&
  name = "measurement.app.time_to_interactive"
}
```

## Errors and trace correlation

Browser exceptions/error logs:

```logsql
collector:"alloy"
  app_name:"storefront-web"
  kind:~"exception|log"
  _msg:~"(?i)(error|exception|fatal|panic)"
| fields _time, _msg, kind, level, app_name, app_version, page_url,
         session_id, trace_id, span_id
| sort by (_time desc)
| limit 200
```

Server container/OTLP logs use the fields provisioned by the cluster pipeline;
keep `trace_id` and retrieve it directly in Tempo. Search error traces when no
log context exists:

```traceql
{
  resource.service.name = "storefront" &&
  resource.deployment.environment.name = "production" &&
  span:status = error
}
```

Slow errors for one deployed release:

```traceql
{
  resource.service.name = "storefront" &&
  resource.service.version = "FULL_DEPLOYED_GIT_SHA" &&
  span:status = error &&
  span:duration > 1s
}
```

Error ratio from Tempo span metrics:

```promql
sum(rate(traces_spanmetrics_calls_total{
  service="storefront",
  status_code="STATUS_CODE_ERROR"
}[5m]))
/
clamp_min(
  sum(rate(traces_spanmetrics_calls_total{service="storefront"}[5m])),
  0.000001
)
```

## Releases and exact commit links

List releases observed in traces:

```promql
max by (service, service_namespace, service_version, deployment_environment_name) (
  traces_target_info{service="storefront"}
)
```

Compare browser error volume by exact commit:

```logsql
collector:"alloy" app_name:"storefront-web" kind:"exception"
| stats by (_time:15m, app_version) count() as errors
```

Build a link from the allowlisted repository metadata plus the full
`service_version`/`app_version` SHA:

```text
https://github.com/OWNER/REPOSITORY/commit/FULL_DEPLOYED_GIT_SHA
```

Do not construct links from a repository URL supplied by an arbitrary public
payload. Dashboards should use a known project-to-repository mapping.

## Event volume and bounded breakdowns

```logsql
collector:"alloy" app_name:"storefront-web" kind:"event"
| stats by (_time:1h, event_name) count() as events
```

Top stable events:

```logsql
collector:"alloy" app_name:"storefront-web" kind:"event"
| top 20 by (event_name)
```

For custom dimensions, first discover the flattened field name, verify it is
bounded, then add it to `stats by`. Do not group by session, subject, URL,
trace, error message, or other unbounded values in long-lived dashboard series.

## Stripe commerce totals

`@davidilie/telemetry-stripe` emits normalized events plus integer
`minor_currency_unit` measurements. For dashboard totals, enable the Node/Next
adapter's `measurementMode: "metrics"` or `"both"`, configure a metric reader,
and allow only the package's documented bounded commerce attributes.

After a canary, discover the backend's normalized series and label names in
Grafana Explore. For a Prometheus-compatible pipeline, the intended query shape
is:

```promql
sum by (commerce_currency, commerce_mode) (
  increase(commerce_payment_amount_sum{
    service_name="storefront",
    commerce_outcome="succeeded"
  }[$__range])
)
```

The result remains an integer in the currency's minor unit. Divide only in the
presentation layer using that currency's exponent; do not assume every
currency has two decimal places. Never sum different currencies.

Select exactly one canonical family for a financial question:

- `commerce.payment.amount` from `payment_intent.succeeded` for payment volume,
  or `commerce.invoice.amount` from `invoice.paid` for invoice collections;
- `commerce.refund.amount` from `refund.created` for refunds;
- `commerce.dispute.amount` from `charge.dispute.created` for opened disputes.

Do not combine Checkout, PaymentIntent, Charge, and Invoice amounts: Stripe can
emit each for one underlying payment. These panels are operational telemetry,
not an accounting ledger. Reconciliation, MRR, LTV, taxes, exchange rates, and
authoritative financial reporting belong in billing data/storage.

## Coarse session funnel

This query answers “what fraction of observed Faro sessions containing the
start event also contained the completion event in the selected window?”

```logsql
collector:"alloy"
  app_name:"storefront-web"
  kind:"event"
  event_name:~"checkout.started|checkout.completed"
| stats by (session_id)
    count() if (event_name:"checkout.started") as started,
    count() if (event_name:"checkout.completed") as completed
| filter started:>0
| stats
    count() as sessions_started,
    count() if (completed:>0) as sessions_completed
| math round(100 * sessions_completed / sessions_started, 2) as completion_percent
```

This is a co-occurrence funnel, not a strict ordered funnel. It does not enforce
that completion happened after start, cannot bridge session rotation, and is
biased by browser/session sampling and blocked telemetry. For an ordered,
identity-aware, auditable funnel, export purpose-approved events to a real
analytics model; do not pretend LogsQL is one.

## Retention-like return activity

Without a stable subject key, report returning *sessions* or daily aggregate
activity—not returning users. `session_id` is intentionally ephemeral.

If privacy review approves a pseudonymous `analytics.subject` field, first find
its flattened VictoriaLogs field name, then produce one row per subject/day:

```logsql
collector:"alloy" app_name:"storefront-web" kind:"event" event_name:"app.active"
| stats by (_time:1d, <subject_field>) count() as activity
```

Export those bounded time slices and compute cohort intersections outside
VictoriaLogs:

```text
day-N retention = subjects active on cohort day 0 and day N
                  / subjects active on cohort day 0
```

State the pseudonym rotation period and deletion behavior. If identifiers rotate
weekly, a 30-day user-retention claim is invalid. Never use raw user IDs or make
the subject field a stream/Prometheus label.

## Gateway and ingestion health

```promql
sum by (project, route, result) (
  increase(telemetry_gateway_requests_total{project="storefront"}[1h])
)
```

```promql
sum by (project, route, result) (
  rate(telemetry_gateway_requests_total{
    result=~"forbidden_origin|invalid_key|rate_limited|upstream_error|unavailable|route_disabled|forbidden_method|forbidden_header|body_too_large|request_error"
  }[5m])
)
```

Read the gateway README/current metrics before fixing an alert to result names.
Structured gateway logs have more specific `outcome` values for upstream
rejection/timeout/unavailability, while the bounded metric uses
`upstream_error`/`unavailable`. Gateway success counts prove
that Alloy responded successfully, not that Tempo/VictoriaLogs/Prometheus
retained the record.

## Agent investigation contract

An agent answering an analytics question should return:

1. Project/service/environment, UTC window, and comparison window
2. Datasource and exact query used
3. Sampling, consent, retention, and missing-signal caveats
4. Result grouped only by bounded dimensions
5. Representative trace IDs for errors/slow paths, with sensitive fields
   redacted
6. Exact `service.version` SHA and known-repository commit link
7. One evidence-based conclusion and the next discriminating query

Prefer read-only Grafana, VictoriaLogs, Tempo, and Prometheus integrations. A
query request does not authorize dashboard, retention, or deployment changes.

References: [VictoriaLogs LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/), [Grafana TraceQL](https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/), and [Alloy Faro receiver](https://grafana.com/docs/alloy/latest/reference/components/faro/faro.receiver/).
