# Informe C4 — Despliegue desde cero en cuenta limpia

> **Estado honesto (2026-11-13):** C4 (pasada completa desde una cuenta/laboratorio vacío) está **pendiente de ejecución**: el laboratorio voclabs se sigue reseteando entre sesiones y esta sesión no autoriza las APIs de lectura (ver `docs/informe-b10.md`). No se afirma un "verificado desde cero" que aún no se demuestra en la fecha actual.

## Objetivo

Demostrar y documentar el despliegue completo de DocuProcess Cloud desde una **cuenta/laboratorio vacío**, sin pasos manuales ocultos: IaC + scripts + verificación E2E.

## Evidencia previa de "desde vacío" (no sustituye a C4)

- 2026-11-13 (pre-B9): apply desde estado vacío en el laboratorio — `plan 68 to add, 0 change, 0 destroy` → `APPLY3_EXIT=0`. Recursos creados: red (VPC, IGW, RTBs, 4 subnets, SGs, endpoints), 3 buckets S3 (PAB/SSE/CORS/OAC), RDS `docuprocess-dev-mysql`, DynamoDB `documents`/`document_events`, SNS `docuprocess-dev-alerts` + suscripción confirmada, ALB/TG `:8000`, ASG `docuprocess-dev-app-v1` (2× t3.micro), CloudFront, SSM params (`/docuprocess-dev/db_password`, `/docuprocess-dev/jwt_secret`).
- En la recreación posterior (B9): `plan -refresh=true` → **64 to add, 0 change, 3 destroy** → apply 64 added; SNS confirmado; frontend republicado y invalidación verificada.

Ambas pasadas fueron interrumpidas por reinicios del laboratorio (voc-cancel-cred) y por huérfanos sin tag; el procedimiento del troubleshooting vive en `docs/guias/despliegue.md`.

## Qué no se ha demostrado

- Ninguna pasada completa **sin interrupciones** termina aún en un único run reproducible (los dos anteriores requirieron reintentos/ajustes del lab).
- No hay C4 para la sesión del 13-nov: el lab quedó vacío de nuevo entre sesiones.

## Procedimiento para la sesión C4 (2026-11-17, laboratorio nuevo)

1. Abrir laboratorio nuevo (AWS Academy), copiar credenciales; `~/.aws/credentials` → perfil del lab.
2. `cp infra/terraform.tfvars.example infra/terraform.tfvars` (completar `alert_email`, `db_password`, `jwt_secret`).
3. `./scripts/package-app.sh`.
4. `terraform -chdir=infra init` y `terraform plan -out=tfplan` (esperado: plan completo desde vacío; revisar y anotar el `to add`).
5. `terraform apply tfplan`; confirmar el correo de SNS.
6. `./scripts/deploy-frontend.sh`; abrir `https://$(terraform -chdir=infra output -raw cloudfront_domain_name)/` → `/api/health` 200.
7. E2E: registro/login; subida PDF/PNG → `DONE`; corrupto → `FAILED`; documento ajeno → 404; correo SNS recibido; bitácora `document_events`; alarma de prueba (umbral bajo) visible en consola.
8. (Opcional) `destroy` y reanotar outputs para el informe.
9. Anotar en este documento: fecha, `to add` del plan, tiempos y enlace a capturas **redactadas**; actualizar `docs/trazabilidad.md` si corresponde.

## Estado final (cierre 2026-11-13)

- **Planificado** para el 2026-11-17 (issue #23). ⚠️
- **Dependiente de**: sesión del lab con permisos de observación (igual que B10/A8) + SNS confirmado del buzón del equipo.
