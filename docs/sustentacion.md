# Sustentación — DocuProcess Cloud

> Documento de cierre para la presentación y defensa. Mapea cada criterio de la rúbrica a la evidencia del repositorio. Honestidad primero: los puntos con limitación del Sandbox están marcados.

## Cómo demostrar el sistema (guion de 5–10 min)

1. **Repo**: `git log --oneline` (progreso incremental C1→C5), estructura modular `infra/modules/*` (8 módulos), CI en verde en `main`.
2. **Estado del despliegue**: `terraform -chdir=infra plan` → sin cambios (o 73 add desde vacío; ver `docs/informe-c4.md`). Nota: en algunas sesiones del laboratorio las APIs de lectura (`describe-*`, `GetMetricStatistics`, `LookupEvents`) pueden estar denegadas por SCP; en ese caso, usar la consola. En las sesiones de entrega del 13-nov respondieron (ver `docs/informe-b10.md`).
3. **Arquitectura**: README (diagrama) + `docs/architecture.md` §1 — explicar el flujo: usuario → CloudFront → S3 frontend (estático, OAC) · `/api/*` → ALB → ASG (2–4 instancias t3.micro) → EC2 (API + worker) → RDS (cuentas) y DynamoDB (metadatos/bitácora); worker → SNS + `document_events`.
4. **Demo en vivo** (desde /api vía CloudFront):
   - Registro + login → subir PDF → `DONE` con páginas y SHA-256; PNG → `DONE` con dimensiones.
   - `corrupt.pdf` → `FAILED` (`unsupported file type`).
   - Con otra cuenta, el documento de otro usuario → 404 (anti-enumeración).
5. **Tolerancia a fallo**: el ALB y el ASG reemplazan instancias (drill 2026-11-13: un `terminate-instances` → ALB 200 continuo, ASG reemplazó 1 instancia; 5xx transitorios ~1–4 min esperados).
6. **Alarmas y notificaciones**: `docuprocess-dev-*` (EC2 CPU, RDS CPU/conexiones/almacenamiento) → SNS → correo del equipo (confirmar suscripción antes de presentar).
7. **Auditoría**: `document_events` (bitácora append-only del documento: PENDING→PROCESSING→DONE/FAILED) + CloudTrail (modo `event-history`; `scripts/verify-cloudtrail.sh` con permisos suficientes).

## Rúbrica → evidencia

| Criterio (peso) | Evidencia | Dónde |
| --- | --- | --- |
| **IaC y arquitectura (30 %)** | Terraform modular (8 módulos: network, storage, dynamodb, sns, rds, compute, cdn, monitoring); VPC 2 públicas + 2 privadas, IGW, route tables, VPC endpoints; ALB público + TG `:8000` con health `/api/health`; ASG 2–4 t3.micro con target tracking 60 % CPU; RDS MySQL Single-AZ db.t3.micro (gp2 ≤ 100 GB); 3 buckets S3 (PAB/SSE/OAC/CORS); DynamoDB 2 tablas PAY_PER_REQUEST + PITR; SSM (sin SSH, sin IAM propio, IMDSv2); gp2 en todo | `infra/`, `docs/trazabilidad.md` §2 |
| **Arquitectura y análisis (25 %)** | Diagrama de componentes (README) + detallado con flujo del documento y tablas de eventos/componentes; SG chain ALB→app→RDS; OAC+CloudFront sin ACM; CI en PR y `main` | `README.md`, `docs/architecture.md` §1 |
| **Diseño de datos (20 %)** | RDS para usuarios (ACID, `UNIQUE email`, bcrypt) vs. DynamoDB (metadatos): `documents` + `document_events` append-only; GSIs (`userId-createdAt`, `status-createdAt`, `userId-eventAt`, `day-eventAt`); transacción PENDING→PROCESSING→DONE; fallback `DDB_TRANSACTIONS=false` | `docs/rds-vs-dynamodb.md`, `infra/modules/dynamodb`, `app/api/src/`, `app/worker/src/` |
| **Monitoreo, alertas y resiliencia (15 %)** | Alarmas CloudWatch (EC2 CPU; RDS CPU/conexiones/almacenamiento) → SNS → correo; `create_before_destroy` + draining 30 s; `/api/ready` gate en userData; drill de terminación validado 2026-11-13 (no es A8); CloudTrail event-history (limitación: SCP deniega `CreateTrail` en el Sandbox) | `infra/modules/monitoring`, `docs/informe-b10.md`, `docs/trazabilidad.md` |
| **Documentación y sustentación (10 %)** | Guía de despliegue con troubleshooting (`docs/guias/despliegue.md`); informes b3/b5/b9/b10; trazabilidad requisito→evidencia; guía de sustentación; README actualizado | `docs/`, `docs/guias/`, `docs/sustentacion.md` |

## Checklist de demo (13 de noviembre)

- [ ] `aws sts get-caller-identity` → cuenta del laboratorio (perfil del lab; el `default` apunta a otra cuenta).
- [ ] `terraform -chdir=infra plan` sin sorpresas (o apply desde vacío; ~73 recursos).
- [ ] CloudFront responde `200`; registro/login desde navegador.
- [ ] Subida PDF → `DONE` (páginas + SHA-256); corrupto → `FAILED`; 404 cruzado.
- [ ] SNS: correo de «Suscripción confirmada»/avisos recibidos (antes de presentar, confirma el inbox).
- [ ] Alarmas `docuprocess-dev-*` visibles en consola y suscripción confirmada (o captura en `docs/informe-b10.md`).
- [ ] En la consola: CloudTrail → Event history (filtrar `RunInstances`, `CreateDBInstance`, etc.).
- [ ] `npm test` verde en CI de `main` (API 68 + worker 28).

## Riesgos y mitigaciones conocidos

| Riesgo | Mitigación |
| --- | --- |
| SNS `PendingConfirmation` (el correo nunca llega) | Confirmar la suscripción **antes** de presentar; entregas 3/0 una vez confirmada |
| Algunas sesiones del Sandbox pueden denegar APIs de lectura (`Describe*`, `LookupEvents`, `GetMetricStatistics`) | En las sesiones de entrega respondieron; si vuelve a pasar, usar la consola para ver alarmas/eventos (ver `docs/informe-b10.md`) |
| `TransactWriteItems` denegado por SCP | `enable_dynamodb_transactions=false` (escritura secuencial; deuda documentada) |
| PROCESSING huérfano (worker muerto tras el claim) | Reset con `aws dynamodb update-item ... status=PENDING` (ver `docs/guias/despliegue.md`) |
| Credenciales expiradas (lab se reinicia) | Volver a copiar del lab (5 min); `invoke new apply` es idempotente |
| `cloudtrail:CreateTrail` denegado | `event-history` (90 días vía `verify-cloudtrail.sh`); ya documentado |
| A8: repetición en vivo (opcional) | Evidencia ya capturada (2026-11-11 y 2026-11-13): CPU 98-99 % → ASG 2→4 a los +333 s; se puede repetir en la defensa o adjuntar capturas |

## Respuestas cortas para la defensa

- **«¿Por qué DynamoDB y no solo MySQL?»** — Metadatos e historial se acceden por patrones de consulta por usuario; escritura alta y append-only sin JOINs: DynamoDB `PAY_PER_REQUEST` con PITR; RDS se reserva para usuarios/autenticación (unicidad y transacciones ACID). Ver `docs/rds-vs-dynamodb.md`.
- **«¿Cómo evita duplicados el worker?»** — Claim transaccional `PutItem` condicional (`status=PENDING` → `PROCESSING`) + evento en la misma transacción; un segundo worker recibe `ConditionalCheckFailed` y continúa con el siguiente documento.
- **«¿Qué pasa si una instancia muere?»** — Health check `/api/health` en el TG; ALB deja de enviarle tráfico; ASG (CPU 60 % target tracking) reemplaza; draining 30 s; `Restart=always` en systemd para los servicios.
- **«¿Hay auditoría?»** — `document_events` por cada transición (PENDING→PROCESSING→DONE/FAILED) + CloudTrail (event-history en el Sandbox); alarmas CloudWatch → SNS → correo del equipo.
- **«¿El despliegue es reproducible?»** — Terraform modular + `package-app.sh` determinista (zip con md5) + `deploy-frontend.sh` (chequeo de cuenta y outputs) + CI en PRs (fmt/validate/tests/shellcheck/empaquetado) + guía `docs/guias/despliegue.md`.
- **«¿Qué falta?»** — Nada crítico: la evidencia viva de alarmas (`OK`, acción SNS) y de carga (escalado 2→4 con CPU 98-99 %) ya se capturó el 2026-11-13 en la sesión de entrega (ver `docs/informe-b10.md` e `docs/informe-a8.md`). Queda únicamente el scale-in automático 4→2 (~15 min de CPU baja) y, opcionalmente, capturar la alarma en estado `ALARM` durante la demo.
