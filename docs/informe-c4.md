# Informe C4 — Despliegue desde cero en cuenta limpia

> **Estado (2026-11-13 ~17:00–18:00 UTC): ejecutado.** Despliegue en vivo desde `main` en la sesión de entrega, cuenta voclabs (<AWS_ACCOUNT_ID>), el mismo día de la entrega final (13 de noviembre de 2026). Este documento refleja lo ocurrido, sin adornos.

## Objetivo

Demostrar y documentar el despliegue completo de DocuProcess Cloud desde una cuenta/laboratorio **vacío**, sin pasos manuales ocultos: IaC + scripts + verificación E2E.

## Qué pasó realmente (2026-11-13)

El laboratorio **no estaba limpio**: al reutilizarlo, conservó recursos de un despliegue anterior del mismo día.

- **Borrados por el reset del lab**: EC2/ASG/ALB/CloudFront (NXDOMAIN confirmado al consultar el DNS de la mañana).
- **Sobrevivientes**:
  - RDS `docuprocess-dev-mysql` (siguió `available` durante todo el día).
  - Parámetros SSM `SecureString` `/docuprocess-dev/db_password` y `/docuprocess-dev/jwt_secret` (versión 1).
  - OAC de CloudFront `E3WD19JOMQIQV` (`docuprocess-dev-frontend-oac`).
- **Primer apply (tfplan, 73 recursos)**: falló en 3 recursos — los dos `aws_ssm_parameter` (`ParameterAlreadyExists`) y `module.cdn.aws_cloudfront_origin_access_control.frontend` (`OriginAccessControlAlreadyExists`). Sus dependientes no llegaron a crearse.
- **Resolución** (solo bookkeeping, sin borrar ni mutar la cuenta): `terraform import` de los 3 huérfanos → re-`plan` → **7 to add, 0 change, 0 destroy** → segundo `apply` **OK**:
  `module.cdn.aws_cloudfront_distribution.this`, `module.cdn.aws_s3_bucket_policy.frontend`, `module.compute.aws_launch_template.app`, `module.compute.aws_autoscaling_group.app`, `module.compute.aws_autoscaling_policy.cpu`, `module.monitoring.aws_cloudwatch_metric_alarm.ec2_cpu`, `module.storage.aws_s3_bucket_cors_configuration.docs`.
- Lección para `docs/guias/despliegue.md`: el lab voclabs **no** resetea SSM params ni OAC; "desde cero" en voclabs requiere el import de huérfanos cuando el lab se reutiliza el mismo día. La guía ya cubre el caso `ParameterAlreadyExists`.

## Estado final del stack (verificado en vivo 2026-11-13)

| Recurso | Estado |
| --- | --- |
| VPC `vpc-00f41a2667db6ffc4` | OK |
| ALB `docuprocess-dev-alb` | OK; TG `docuprocess-dev-app` :8000, health `/api/health` |
| ASG `docuprocess-dev-app-v1` | Desired=2, InService=2 |
| Targets | 2/2 **healthy** |
| CloudFront | `d39qhfy6fiy63b.cloudfront.net` (dist `E2587IYX3FWIVO`) |
| Buckets S3 | `docuprocess-dev-{docs,frontend,artifacts}-77d1730d` |
| RDS `docuprocess-dev-mysql` | `available` (reutilizado; db.t3.micro Single-AZ) |
| DynamoDB | `documents`, `document_events` activas |
| SNS `docuprocess-dev-alerts` | suscripción `<TEAM_EMAIL>` = **PendingConfirmation** al desplegar; confirmada después (13-nov) |
| CloudTrail | modo `event-history` (sin trails; documentado) |
| Alarmas (4) | todas **OK**, 1 acción hacia SNS |

## Verificación E2E (vía CloudFront, 2026-11-13 ~17:50 UTC)

1. `GET /api/health` → 200; `GET /api/ready` → 200.
2. Registro `demo-final-13nov@example.com` → 201 (`id: 1`); login → token JWT.
3. `POST /api/documents` (`enunciado-demo.pdf`, application/pdf, 136 265 B) → presigned PUT; PUT a S3 → 200.
4. Worker procesó el documento `adf1248b-e498-4bda-8c1e-46271043da23` → **DONE**: `result={mimeType: application/pdf, pages: 7, sha256: 9bef8e2d…, sizeBytes: 136265}`.

## Notas de la sesión

- Las APIs de lectura **sí funcionaron** en esta sesión (a diferencia de la sesión previa temprano ese mismo día, que vio denegaciones SCP).
- Los IDs de esta sección (VPC, buckets, CloudFront) corresponden a este despliegue final; las sesiones anteriores del mismo día (C3/B9) usaron otros IDs.
- El RDS sobrevivió al reset del lab: no es un "desde cero" de datos, pero sí de infraestructura de aplicación/edge/alarma.
- La suscripción SNS quedó `PendingConfirmation` al desplegar; se confirmó el buzón después ese mismo día (13-nov), así que las alertas ya se entregan (ver la evidencia de monitoreo).
- `terraform destroy` no se ejecutó (el stack se conserva para la defensa/demo).

## Conclusión

C4 queda **demostrado en la fecha de entrega** (2026-11-13), con la salvedad honesta de que el laboratorio voclabs no ofrece un "vacío real": la limpieza de huérfanos (2 SSM params + 1 OAC) fue parte del ejercicio y está documentada para reproducirla. El procedimiento completo (credenciales → tfvars → package-app → apply → SNS → deploy-frontend → E2E → destroy) vive en `docs/guias/despliegue.md`.

