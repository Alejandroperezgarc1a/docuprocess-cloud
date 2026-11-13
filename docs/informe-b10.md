# Informe B10 — Monitoreo y avisos (CloudWatch + SNS + CloudTrail)

> **Estado (2026-11-13): Verificado.** El módulo `monitoring` está implementado, cableado y en `main` (merge vía PR #51). La verificación en vivo se realizó en **dos sesiones del Sandbox de entrega** (mañana con la pila #50–#52; tarde, despliegue desde cero): las 4 alarmas se crearon, el historial de la alarma muestra la ejecución de la acción hacia el SNS, y `verify-cloudtrail.sh` devolvió eventos (es decir, `cloudtrail:LookupEvents` funciona). Si en alguna sesión las APIs de lectura llegan a estar denegadas por SCP, usar la consola (ver «Nota sobre el Sandbox»).

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

## Evidencia viva — sesión de la mañana del 13-nov (equipo, pila #50–#52)

Aplicado junto con #50 + #51 + #52 (apply de 73 recursos):

- Las **4 alarmas** se crearon y el historial de la alarma muestra: `Successfully executed action … docuprocess-dev-alerts` — es decir, **CloudWatch → SNS funciona** de extremo a extremo.
- `scripts/verify-cloudtrail.sh` devolvió **eventos** → **`cloudtrail:LookupEvents` funciona** en esta cuenta (historial de 90 días).
- Misma corrida: frontend + API vía CloudFront; E2E OK (PDF/PNG → DONE; PDF falso → FAILED en ~5 s; bitácora auditable; 404 para otro usuario; 401 sin token).

## Evidencia viva — sesión de la tarde del 13-nov (despliegue desde cero)

En la sesión de despliegue desde cero de la entrega, **las APIs de lectura sí respondieron** (cuenta voclabs 491699813584). Evidencia capturada:

- `aws ec2 describe-instances` → 2 instancias `running` en us-east-1a/1b (`i-01ad8be4d7168cd5f`, `i-03f1436f858e72c8c`).
- `aws autoscaling describe-auto-scaling-groups` → `docuprocess-dev-app-v1`: Desired=2, InService=2, Pending=0.
- `aws elbv2 describe-target-health` → `docuprocess-dev-app:8000` → ambos targets **healthy** (`/api/health`).
- `aws cloudwatch describe-alarms` → las 4 alarmas en estado **OK** con 1 acción hacia el SNS `docuprocess-dev-alerts`:
  `docuprocess-dev-ec2-cpu-high`, `docuprocess-dev-rds-cpu-high`, `docuprocess-dev-rds-connections-high`, `docuprocess-dev-rds-free-storage-low`.
- `aws sns list-topics` → `arn:aws:sns:us-east-1:491699813584:docuprocess-dev-alerts`; suscripción `ingesoftv@gmail.com` = **confirmada por el usuario** (el 13-nov) — las alertas ya se entregan.
- `aws dynamodb list-tables` → `documents`, `document_events`.
- Vía CloudFront: `GET /api/health` → 200 y `GET /api/ready` → 200.
- `aws cloudtrail` sin trails (modo `event-history` por defecto): `verify-cloudtrail.sh` documenta el historial de 90 días; el Sandbox deniega `cloudtrail:CreateTrail`.

Historial: la sesión previa (misma fecha, temprano) sí vio denegadas estas APIs; la sesión final de la entrega no las denegó. Por eso este informe refleja evidencia viva, no solo estado de código.

## Cómo cerrar la evidencia de B10 en la presentación (paso a paso)

En la sesión del Sandbox del día / en consola AWS:

1. **Consola CloudWatch → Alarmas**: buscar el prefijo `docuprocess-dev-` y confirmar los 4 nombres y el estado (`OK` o `INSUFFICIENT_DATA`). `INSUFFICIENT_DATA` al poco de aplicar es normal: pide la primera métrica (5 min).
2. **Suscripción SNS**: tema `docuprocess-dev-alerts` → suscripciones → confirmar correo del equipo (si aparece `PendingConfirmation`, la demo de alarmas no llegaría: confirmar antes de presentar).
3. **Alarma en acción** (opcional pero convincente): bajar temporalmente el umbral de `docuprocess-dev-ec2-cpu-high` a 1 % y dejar pasar 2 períodos de evaluación → la alarma pasa a `ALARM` → llega el correo → restaurar el umbral a 80.
4. **Registro de eventos**: consola CloudTrail → Event history (90 días) filtrando `Event name = RunInstances`, `StopInstances`, `CreateDBInstance`, `PutBucket...`, etc.
5. Si la sesión lo permite: `cloudtrail_mode = "trail"` y `terraform apply`, verificando el bucket `docuprocess-cloudtrail-*` y el trail `docuprocess-dev-trail` en la consola.

En cualquiera de los dos casos, actualizar `docs/trazabilidad.md` (filas 9 y 10) y enlazar capturas **redacted** (sin IDs de cuenta/recursos) en esta misma sección.

## Nota sobre el Sandbox

En algunas sesiones del laboratorio las APIs de lectura (`Describe*`, `GetMetricStatistics`, `LookupEvents`) pueden estar denegadas por una SCP; en ese caso, verificar desde la consola. En las sesiones de entrega del 13-nov (mañana y tarde) las APIs respondieron y la evidencia se capturó con CLI.

## Limitaciones del Sandbox (ya documentadas)

- `cloudtrail:CreateTrail` probablemente denegado: se usa `event-history` (no hay trail persistente ni bucket propio).
- `INSUFFICIENT_DATA` inicial es esperado.

## Estado final (cierre 2026-11-13)

- **Código**: implementado, cableado y en `main` (PR #51). ✅
- **Verificación viva**: **obtenida y repetida** — mañana: alarmas con acción `Successfully executed action … docuprocess-dev-alerts` y `LookupEvents` con eventos; tarde: 4 alarmas `OK` con 1 acción SNS, ASG 2/2 → 4/4 bajo carga, TG healthy, health/ready 200, tablas activas. ✅
- **SNS**: suscripción `ingesoftv@gmail.com` **confirmada** por el usuario el 13-nov — las alertas ya se entregan. ✅
- **Trazabilidad**: filas 9 y 10 actualizadas a `Verificado` con la fecha 2026-11-13. ✅
- **Opcional para la defensa**: demo de alarma en estado `ALARM` (bajar umbral de `docuprocess-dev-ec2-cpu-high` a 1 %, esperar 2 períodos, restaurar) o capturas de la consola; enlazarlas aquí con IDs redactados.

