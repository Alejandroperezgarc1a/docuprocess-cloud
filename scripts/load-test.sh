#!/usr/bin/env bash
# Prueba de carga (A8): satura la CPU del ASG con logins (bcrypt, costo 12) directo contra el ALB
# y muestra cada 30 s cómo responde el escalado de A7.
#
# Uso: scripts/load-test.sh [URL_BASE] [DURACION_SEG] [CONCURRENCIA]
#   URL_BASE      por defecto http://<output alb_dns_name>  (el ALB, no CloudFront: no se mide la caché)
#   DURACION_SEG  por defecto 600 (10 min)
#   CONCURRENCIA  por defecto 50
# Variables opcionales: ASG_NAME (por defecto el output asg_name), AWS_REGION (us-east-1),
#   INTERVALO (30), LOG_DIR (carpeta donde quedan la salida de ab y el seguimiento; por defecto un temporal).
set -euo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra" && pwd)"
region="${AWS_REGION:-us-east-1}"
intervalo="${INTERVALO:-30}"

for cmd in ab aws terraform curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "load-test: falta '$cmd'. ab viene en apache2-utils (Debian/Ubuntu) o httpd-tools (AL2023/RHEL)." >&2
    exit 1
  fi
done

tf_output() { terraform -chdir="$infra_dir" output -raw "$1" 2>/dev/null; }

base_url="${1:-}"
if [ -z "$base_url" ]; then
  alb="$(tf_output alb_dns_name)" || { echo "load-test: no hay output alb_dns_name; pasar la URL base." >&2; exit 1; }
  base_url="http://$alb"
fi
base_url="${base_url%/}"
duracion="${2:-600}"
concurrencia="${3:-50}"
asg_name="${ASG_NAME:-$(tf_output asg_name || true)}"
[ -n "$asg_name" ] || { echo "load-test: no hay output asg_name; definir ASG_NAME." >&2; exit 1; }

log_dir="${LOG_DIR:-$(mktemp -d)}"
mkdir -p "$log_dir"
body="$log_dir/login.json"
ab_out="$log_dir/ab.txt"
seguimiento="$log_dir/asg.txt"

# 1. Usuario de prueba propio (correo único por corrida).
email="carga-$(date +%s)@docuprocess.test"
password="carga-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '{"email":"%s","password":"%s"}' "$email" "$password" > "$body"

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$body" "$base_url/api/auth/register")"
[ "$code" = "201" ] || { echo "load-test: el registro devolvió HTTP $code (se esperaba 201)." >&2; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$body" "$base_url/api/auth/login")"
[ "$code" = "200" ] || { echo "load-test: el login de prueba devolvió HTTP $code (se esperaba 200)." >&2; exit 1; }

echo "load-test: $base_url  ASG=$asg_name  ${duracion}s  concurrencia=$concurrencia"
echo "load-test: usuario $email; salidas en $log_dir"

capacidad() {
  # shellcheck disable=SC2016  # las comillas invertidas son literales de JMESPath, no de bash
  aws autoscaling describe-auto-scaling-groups --region "$region" \
    --auto-scaling-group-names "$asg_name" \
    --query 'AutoScalingGroups[0].[DesiredCapacity, length(Instances[?LifecycleState==`InService`]), length(Instances)]' \
    --output text 2>/dev/null | awk '{printf "Desired=%s InService=%s Total=%s", $1, $2, $3}'
}

cpu_promedio() {
  # Último punto de la CPU promedio del grupo. Sin monitoreo detallado EC2 publica cada 5 min,
  # así que el valor va atrasado; el target tracking de A7 usa esta misma métrica.
  aws cloudwatch get-metric-statistics --region "$region" --namespace AWS/EC2 \
    --metric-name CPUUtilization --dimensions "Name=AutoScalingGroupName,Value=$asg_name" \
    --start-time "$(date -u -d '-15 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
    --period 300 --statistics Average \
    --query 'sort_by(Datapoints,&Timestamp)[-1].Average' --output text 2>/dev/null \
    | awk '$1 != "None" {printf "CPU=%.0f%%", $1; next} {printf "CPU=s/d"}'
}

ab_pid=""
terminar() {
  trap - INT TERM
  if [ -n "$ab_pid" ] && kill -0 "$ab_pid" 2>/dev/null; then
    kill -INT "$ab_pid" 2>/dev/null || true
    wait "$ab_pid" 2>/dev/null || true
  fi
  echo
  echo "== Resultado de ab ($ab_out)"
  grep -E '^(Complete requests|Failed requests|Non-2xx responses|Requests per second|Time per request|Percentage)|^ +(50|90|99|100)%' "$ab_out" || true
  echo
  echo "== Últimas actividades del ASG"
  aws autoscaling describe-scaling-activities --region "$region" --auto-scaling-group-name "$asg_name" \
    --max-items 8 --query 'Activities[].[StartTime, StatusCode, Description]' --output text || true
  echo
  echo "load-test: seguimiento en $seguimiento. El ASG baja a 2 unos 15 min después (AlarmLow necesita 15 puntos)."
  exit 0
}
trap terminar INT TERM

# 2. Carga: -t limita por tiempo (el -n alto evita que corte antes), -l acepta respuestas de largo
#    variable, -s 60 iguala el idle timeout del ALB, -r no aborta ante errores de socket.
ab -t "$duracion" -n 100000000 -c "$concurrencia" -s 60 -l -r \
  -p "$body" -T application/json "$base_url/api/auth/login" > "$ab_out" 2>&1 &
ab_pid=$!

# 3. Seguimiento del ASG mientras ab corre.
inicio=$(date +%s)
while kill -0 "$ab_pid" 2>/dev/null; do
  linea="$(date +%T) +$(( $(date +%s) - inicio ))s  $(capacidad)  $(cpu_promedio)"
  echo "$linea" | tee -a "$seguimiento"
  for _ in $(seq "$intervalo"); do
    kill -0 "$ab_pid" 2>/dev/null || break
    sleep 1
  done
done
wait "$ab_pid" 2>/dev/null || true
ab_pid=""
terminar
