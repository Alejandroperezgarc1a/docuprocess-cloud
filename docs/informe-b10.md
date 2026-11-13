# Informe B10 — Monitoreo y avisos (CloudWatch + SNS + CloudTrail)

> **Estado honesto del cierre (2026-11-13):** el módulo `monitoring` está **implementado, cableado y revisado en código** (`infra/modules/monitoring/main.tf`, `infra/main.tf:257-267`, `infra/outputs.tf`; CI verde en el módulo en `main`). Sin embargo, la **evidencia viva desde la CLI del Sandbox no es producible con este rol**: el SCP del Sandbox deniega explícitamente todas las APIs de lectura usadas por la verificación. El detalle y el procedimiento para cerrarla en una sesión con permisos están más abajo.

## Objetivo de B10

Cerrar el monitoreo del stack: alarmas de infraestructura publicando a SNS y auditoría con CloudTrail.

## Alcance

- Módulo `infra/modules/monitoring/` existente en `main` (merge B10 vía PR #51).
- Alarmas creadas por el módulo (todas con `treat_missing_data = "missing"` y acción hacia el SNS `docuprocess-dev-alerts` con `alarm` y `ok`):

  | Nombre | Alarma | Métrica | Umbral |
  | --- | --- | --- | --- |
  | `docuprocess-dev-ec2-cpu-high` | CPU alta del ASG | `CPUUtilization` (namespace `AWS/EC2`, dimensión `AutoScalingGroupName`) | > 80 % (300 s × 2) |
  | `docuprocess-dev-rds-cpu-high` | CPU alta de RDS | `CPUUtilization` (namespace `AWS/RDS`) | > 80 % |
  | `docuprocess-dev-rds-connections-high` | Conexiones altas de RDS | `DatabaseConnections` | > 50 |
  | `docuprocess-dev-rds-free-storage-low` | Almacenamiento libre bajo | `FreeStorageSpace` | < 2 GiB |

- SNS: tema `docuprocess-dev-alerts` con suscripción de correo del equipo (confirmación manual, una vez por cuenta) y política `aws_sns_topic_policy` que permite publicar a la API y a CloudWatch (`aws:SourceAccount`).
- CloudTrail: `cloudtrail_mode = "event-history"` por defecto (historial de eventos de 90 días; `scripts/verify-cloudtrail.sh` lo consulta). Si la cuenta lo permite, `terraform apply -var cloudtrail_mode=trail` crea el trail y el bucket dedicados (`monitoring/main.tf`).

## Lo verificado (sin acceso AWS)

- `terraform fmt -check -recursive` y `terraform validate` en verde (también en CI para `main`).
- Cableado completo del módulo: entradas `sns_topic_arn`, `asg_name`, `db_identifier`; salidas `alarm_names`, `cloudtrail_*` reexportadas en `infra/outputs.tf`.
- El módulo no crea IAM roles (Sandbox-compatible); IDs interpolados con `default_tags` donde aplica.

## Lo que NO se pudo verificar desde esta sesión (SCP del Sandbox, deny explícito)

La sesión `AWS_PROFILE=academy` (voclabs, cuenta de laboratorio) **no tiene ninguna API de lectura permitida** para el seguimiento. Evidencia textual de los errores:

| Comando | Error (literal) |
| --- | --- |
| `aws autoscaling describe-auto-scaling-groups` | `AccessDenied ... because no identity-based policy allows the autoscaling:DescribeAutoScalingGroups action` |
| `aws autoscaling describe-scaling-activities` | `AccessDenied ... autoscaling:DescribeScalingActivities` |
| `aws cloudwatch describe-alarms` | `AccessDenied ... cloudwatch:DescribeAlarms ... with an explicit deny in a service control policy` |
| `aws cloudwatch get-metric-statistics` | `AccessDenied ... cloudwatch:GetMetricStatistics with an explicit deny in a service control policy` |
| `aws cloudtrail lookup-events` | `AccessDeniedException ... cloudtrail:LookupEvents with an explicit deny in a service control policy` |
| `aws sns list-topics` | `AuthorizationError ... SNS:ListTopics ... explicit deny in a service control policy` |
| `aws ec2 describe-instances` | `UnauthorizedOperation ... ec2:DescribeInstances with an explicit deny in a service control policy` |
| `aws elbv2 describe-target-health` | `AccessDenied ... elasticloadbalancing:DescribeTargetHealth` |

Consecuencia: **esta sesión no puede producir evidencia viva de alarmas (estado, disparo), del ASG escalando ni de eventos CloudTrail.** Cualquier afirmación «verificado en AWS» para B10 requeriría una sesión con esos permisos (o la consola del laboratorio si el rol voclabs la muestra).

## Cómo cerrar la evidencia de B10 en la presentación (paso a paso)

En la sesión del Sandbox del día / en consola AWS:

1. **Consola CloudWatch → Alarmas**: buscar el prefijo `docuprocess-dev-` y confirmar los 4 nombres y el estado (`OK` o `INSUFFICIENT_DATA`). `INSUFFICIENT_DATA` al poco de aplicar es normal: pide la primera métrica (5 min).
2. **Suscripción SNS**: tema `docuprocess-dev-alerts` → suscripciones → confirmar correo del equipo (si aparece `PendingConfirmation`, la demo de alarmas no llegaría: confirmar antes de presentar).
3. **Alarma en acción** (opcional pero convincente): bajar temporalmente el umbral de `docuprocess-dev-ec2-cpu-high` a 1 % y dejar pasar 2 períodos de evaluación → la alarma pasa a `ALARM` → llega el correo → restaurar el umbral a 80.
4. **Registro de eventos**: consola CloudTrail → Event history (90 días) filtrando `Event name = RunInstances`, `StopInstances`, `CreateDBInstance`, `PutBucket...`, etc.
5. Si la sesión lo permite: `cloudtrail_mode = "trail"` y `terraform apply`, verificando el bucket `docuprocess-cloudtrail-*` y el trail `docuprocess-dev-trail` en la consola.

En cualquiera de los dos casos, actualizar `docs/trazabilidad.md` (filas 9 y 10) y enlazar capturas **redacted** (sin IDs de cuenta/recursos) en esta misma sección.

## Limitaciones del Sandbox (ya documentadas)

- `cloudtrail:CreateTrail` probablemente denegado: se usa `event-history` (no hay trail persistente ni bucket propio).
- `INSUFFICIENT_DATA` inicial es esperado.
- SCP deniega también `ec2:DescribeInstances` y `autoscaling:Describe*`: aunque el ASG escale, **no se puede observar vía CLI desde esta sesión**.

## Estado final (cierre 2026-11-13)

- **Código**: implementado, cableado y en `main` (PR #51). ✅
- **Verificación viva (alarmas/ASG/eventos)**: **no obtenible desde la sesión voclabs actual**; documentado el bloqueo y el procedimiento exacto para obtenerla en consola o en una sesión con permisos. ⚠️
- **Trazabilidad**: filas 9 y 10 anotadas como `Implementado` (no `Verificado`) hasta obtener la evidencia.
- **Pendiente para la defensa**: capturar las evidencias del apartado «Cómo cerrar…» en la consola del laboratorio (o sesión con permisos) antes del 17 de noviembre y pegarlas en este documento con los IDs redactados.
