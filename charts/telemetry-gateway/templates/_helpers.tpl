{{- define "telemetry-gateway.name" -}}
telemetry-gateway
{{- end }}

{{- define "telemetry-gateway.labels" -}}
app.kubernetes.io/name: {{ include "telemetry-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

