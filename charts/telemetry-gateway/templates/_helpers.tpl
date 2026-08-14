{{- define "telemetry-gateway.name" -}}
telemetry-gateway
{{- end }}

{{- define "telemetry-gateway.labels" -}}
app.kubernetes.io/name: {{ include "telemetry-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Apply the same optional-route defaults as the gateway runtime. hasKey is
used deliberately because Helm's default function treats explicit false as
empty and would accidentally expose a disabled route. */}}
{{- define "telemetry-gateway.routeEnabled" -}}
{{- if hasKey .project .key -}}
{{- get .project .key -}}
{{- else -}}
{{- .default -}}
{{- end -}}
{{- end }}
