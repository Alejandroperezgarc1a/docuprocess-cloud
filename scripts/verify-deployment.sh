#!/usr/bin/env bash
# Verifica un despliegue de DocuProcess Cloud (C4) o que la cuenta quedó limpia tras el destroy.
# Solo lee: no crea ni borra nada. Termina con código 0 si todo está bien y 1 si algo falla.
#
# Uso (desde cualquier carpeta del repositorio):
#   ./scripts/verify-deployment.sh            # tras terraform apply + deploy-frontend.sh
#   ./scripts/verify-deployment.sh limpieza   # tras terraform destroy: no deben quedar recursos
set -uo pipefail

for cmd in aws terraform curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "falta '$cmd'" >&2; exit 1; }
done

REGION="${AWS_REGION:-us-east-1}"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra" && pwd)"
ok=0
mal=0

pass() { echo "  ✅ $1"; ok=$((ok + 1)); }
fail() { echo "  ❌ $1"; mal=$((mal + 1)); }
expect() { # descripción valor_obtenido valor_esperado
  if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1: esperado '$3', obtenido '${2:-vacío}'"; fi
}
empty() { # descripción valor
  if [ -z "$2" ] || [ "$2" = "None" ]; then pass "$1: nada"; else fail "$1: quedan $2"; fi
}
tf_output() { terraform -chdir="$INFRA_DIR" output -raw "$1" 2>/dev/null; }

echo "== Cuenta"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" ||
  { echo "  ❌ sin credenciales de AWS válidas" >&2; exit 1; }
echo "  cuenta ${ACCOUNT:0:4}…${ACCOUNT: -4} · región $REGION"

if [ "${1:-}" = "limpieza" ]; then
  echo "== Restos del proyecto"
  empty "estado de Terraform" "$(terraform -chdir="$INFRA_DIR" state list 2>/dev/null)"
  empty "instancias EC2" "$(aws ec2 describe-instances --region "$REGION" \
    --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text)"
  empty "Auto Scaling groups" "$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --query 'AutoScalingGroups[].AutoScalingGroupName' --output text)"
  empty "balanceadores" "$(aws elbv2 describe-load-balancers --region "$REGION" \
    --query 'LoadBalancers[].LoadBalancerName' --output text)"
  empty "RDS" "$(aws rds describe-db-instances --region "$REGION" \
    --query 'DBInstances[].DBInstanceIdentifier' --output text)"
  empty "tablas DynamoDB" "$(aws dynamodb list-tables --region "$REGION" --query 'TableNames' --output text)"
  empty "buckets docuprocess" "$(aws s3api list-buckets \
    --query 'Buckets[?starts_with(Name, `docuprocess`)].Name' --output text)"
  empty "parámetros SSM" "$(aws ssm get-parameters-by-path --region "$REGION" --path /docuprocess-dev \
    --query 'Parameters[].Name' --output text)"
  empty "distribuciones CloudFront" "$(aws cloudfront list-distributions \
    --query 'DistributionList.Items[].Id' --output text)"
  empty "tópicos SNS" "$(aws sns list-topics --region "$REGION" --query 'Topics[].TopicArn' --output text)"
  empty "alarmas docuprocess" "$(aws cloudwatch describe-alarms --region "$REGION" \
    --alarm-name-prefix docuprocess --query 'MetricAlarms[].AlarmName' --output text)"
  empty "VPC propias" "$(aws ec2 describe-vpcs --region "$REGION" \
    --filters Name=is-default,Values=false --query 'Vpcs[].VpcId' --output text)"
  echo
  echo "Resultado: $ok OK, $mal con problemas"
  [ "$mal" -eq 0 ]
  exit $?
fi

APP_URL="$(tf_output app_url)"
ALB="$(tf_output alb_dns_name)"
ASG="$(tf_output asg_name)"
if [ -z "$APP_URL" ]; then
  echo "  ❌ no hay outputs de Terraform: ¿se corrió terraform apply en este repositorio?" >&2
  exit 1
fi

echo "== Terraform"
pass "recursos en el estado: $(terraform -chdir="$INFRA_DIR" state list | wc -l | tr -d ' ')"
terraform -chdir="$INFRA_DIR" plan -detailed-exitcode -input=false -lock=false >/dev/null 2>&1
expect "plan sin cambios pendientes (0 = estable)" "$?" "0"

echo "== Cómputo"
expect "instancias InService en el ASG" "$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
  --auto-scaling-group-names "$ASG" \
  --query 'length(AutoScalingGroups[0].Instances[?LifecycleState==`InService`])')" "2"
TG="$(aws elbv2 describe-target-groups --region "$REGION" \
  --query 'TargetGroups[?starts_with(TargetGroupName, `docuprocess`)].TargetGroupArn' --output text | head -1)"
expect "targets healthy en el ALB" "$(aws elbv2 describe-target-health --region "$REGION" \
  --target-group-arn "$TG" \
  --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])')" "2"
expect "política de escalado" "$(aws autoscaling describe-policies --region "$REGION" \
  --auto-scaling-group-name "$ASG" --query 'ScalingPolicies[0].PolicyType' --output text)" "TargetTrackingScaling"
expect "instancias Online en Systems Manager" "$(aws ssm describe-instance-information --region "$REGION" \
  --query 'length(InstanceInformationList[?PingStatus==`Online`])')" "2"

echo "== Datos"
expect "RDS (estado y Multi-AZ)" "$(aws rds describe-db-instances --region "$REGION" \
  --query 'DBInstances[0].[DBInstanceStatus,MultiAZ]' --output text | tr '\t' ' ')" "available False"
for table in "$(tf_output dynamodb_table_name)" "$(tf_output dynamodb_events_table_name)"; do
  expect "DynamoDB $table" "$(aws dynamodb describe-table --region "$REGION" --table-name "$table" \
    --query 'Table.TableStatus' --output text)" "ACTIVE"
done

echo "== Monitoreo"
expect "alarmas de CloudWatch del proyecto" "$(aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-name-prefix docuprocess-dev --query 'length(MetricAlarms)')" "4"
# Las suscripciones pendientes no se pueden borrar (AWS las expira a los 3 días): basta con una confirmada.
CONFIRMED="$(aws sns list-subscriptions-by-topic --region "$REGION" --topic-arn "$(tf_output sns_topic_arn)" \
  --query "length(Subscriptions[?SubscriptionArn!='PendingConfirmation'])" --output text)"
if [ "${CONFIRMED:-0}" -ge 1 ]; then
  pass "suscripción SNS confirmada ($CONFIRMED)"
else
  fail "suscripción SNS sin confirmar: abrir el correo de alert_email y confirmar"
fi
expect "CloudTrail (LookupEvents)" "$(aws cloudtrail lookup-events --region "$REGION" --max-results 1 \
  --query 'length(Events)' 2>/dev/null)" "1"

echo "== Aplicación"
expect "health profundo por CloudFront" "$(curl -s "$APP_URL/api/health?deep=1")" \
  '{"status":"ok","checks":{"mysql":"ok","dynamodb":"ok"}}'
expect "frontend por CloudFront (HTTP)" "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/")" "200"
expect "API sin token (HTTP)" "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/documents")" "401"
expect "ALB directo /api/health (HTTP)" "$(curl -s -o /dev/null -w '%{http_code}' "http://$ALB/api/health")" "200"

echo
echo "Resultado: $ok OK, $mal con problemas"
echo "Aplicación: $APP_URL"
[ "$mal" -eq 0 ]
