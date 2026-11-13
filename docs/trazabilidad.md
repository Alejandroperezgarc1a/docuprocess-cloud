# Trazabilidad: requisito → evidencia → estado

> Matriz de verificación del proyecto. Cada fila responde: **qué pide el enunciado**, **dónde está
> la evidencia** y **qué falta comprobar**. La columna `Última verificación` se actualiza al cerrar
> cada tarea (fecha UTC, `YYYY-MM-DD`).

## 1. Leyenda

| Estado | Significado |
| --- | --- |
| **Verificado** | Comprobado con un comando o prueba reproducible; la evidencia está enlazada |
| **Implementado** | Código/configuración listos y validados localmente, pero falta la prueba en AWS |
| **Pendiente** | Depende de otra tarea o del Sandbox |
| **Riesgo** | El diseño contempla un fallback porque el Sandbox podría denegarlo |

## 2. Matriz general (enunciado y rúbrica)

| # | Requisito | Evidencia | Estado | Última verificación | Riesgo / nota |
| --- | --- | --- | --- | --- | --- |
| 1 | VPC con subredes públicas (ALB) y privadas (app + datos) | `infra/modules/network/`; apply en cuenta 491699813584 OK | Verificado | 2026-11-13 | Aplicado desde estado vacío (apply3) |
| 2 | ALB + ASG 2–4, `t3.micro` | apply OK: 2 instancias InService/Healthy; drill terminación → reemplazo ASG; 2/2 healthy | Verificado | 2026-11-13 | Prueba de carga (A8) pendiente — ver `docs/informe-a8.md` |
| 3 | API y worker en las mismas instancias | `docuprocess-api` y `docuprocess-worker` `active` en AMBAS instancias vía SSM (2026-11-13) | Verificado | 2026-11-13 | — |
| 4 | SSM Session Manager, sin SSH ni bastión | `/etc/docuprocess.env` real completo en ambas instancias vía send-command; API/worker active | Verificado | 2026-11-13 | Rol preexistente (AmazonSSMRoleForInstancesQuickSetup) |
| 5 | RDS MySQL Single-AZ `db.t3.micro` para cuentas y autenticación | apply OK: docuprocess-dev-mysql db.t3.micro disponible (endpoint c9pldrtatyja) | Verificado | 2026-11-13 | — |
| 6 | S3 para archivos | apply OK: buckets docuprocess-dev-{docs,frontend,artifacts}-47cb5959 con PAB/SSE/versioning/CORS/OAC; subida PUT prefirmada OK (3/3) | Verificado | 2026-11-13 | — |
| 7 | DynamoDB para metadatos, historial y resultados | apply OK: tablas ACTIVE; document_events: PENDING→PROCESSING→DONE sin duplicados (3/3 docs) | Verificado | 2026-11-13 | — |
| 8 | SNS para notificaciones | apply OK: topic docuprocess-dev-alerts + suscripción email ingesoftv@gmail.com confirmada; worker `sns_published` (DONE) y CloudWatch `Delivered=3`, `Failed=0` | Verificado | 2026-11-13 | Terraform no puede confirmar la suscripción: la confirmación del buzón es manual (una vez) |
| 9 | CloudWatch: alarmas de CPU de EC2 y métricas de RDS | `infra/modules/monitoring/main.tf`; alarmas `docuprocess-dev-ec2-cpu-high`, `rds-cpu-high`, `rds-connections-high`, `rds-free-storage-low` → SNS `docuprocess-dev-alerts`; ver `docs/informe-b10.md` | Implementado (código); verificación viva bloqueada por SCP | 2026-11-13 | La sesión voclabs deniega todas las APIs de lectura (`describe-alarms`, `get-metric-statistics`, `describe-instances`…): evidencia viva pendiente hasta sesión con permisos o consola |
| 10 | CloudTrail para auditoría | `cloudtrail_mode="event-history"` (default) + `scripts/verify-cloudtrail.sh`; ver `docs/informe-b10.md` | Implementado (con limitación documentada) | 2026-11-13 | `lookup-events` denegado por SCP en esta sesión; con permiso, `-var cloudtrail_mode=trail` crea trail + bucket |
| 11 | IaC modular (Terraform) | apply desde estado vacío OK: Plan 68 to add, 68/68, APPLY3_EXIT=0; módulos network/storage/dynamodb/rds/compute/sns/cdn + monitoring (PR #51) | Verificado | 2026-11-13 | — |
| 12 | Sin `CreateRole`/`GetRole`; solo roles preexistentes | `data.aws_iam_instance_profiles` + políticas basadas en recursos | Verificado | 2026-11-11 | — |
| 13 | EC2 `t2/t3`, máximo 9 concurrentes, EBS `gp2` ≤ 35 GB | `var.instance_type` y `var.root_volume_size` con validaciones | Verificado | 2026-11-11 | — |
| 14 | RDS `gp2` ≤ 100 GB, Single-AZ | `infra/modules/rds/main.tf` | Verificado | 2026-11-11 | — |
| 15 | Comparativa RDS vs. DynamoDB | `docs/rds-vs-dynamodb.md` | Verificado | 2026-11-11 | — |
| 16 | Diagrama detallado y flujo | `README.md` (diagrama de componentes) y `docs/architecture.md` §1 (diagrama detallado, flujo del documento y tabla de componentes/eventos) | Verificado | 2026-11-13 | — |
| 17 | Guía de despliegue y troubleshooting | `docs/guias/despliegue.md` (credenciales, despliegue, verificación, destroy y 12 casos de troubleshooting) | Verificado | 2026-11-13 | — |
| 18 | Demo: subida S3 → worker → DynamoDB → SNS | Flujo E2E 2026-11-13 (vía CloudFront): registro/login; PDF→DONE pages=1; PNG→DONE width/height=1; corrupt.pdf→FAILED unsupported file type; doc ajeno 404; correo SNS por documento | Verificado | 2026-11-13 | — |
| 19 | Prueba de carga para el ASG | `scripts/load-test.sh`; `docs/informe-a8.md` (procedimiento; sesión actual sin evidencia por SCP) | Pendiente A8 | 2026-11-13 | sesión voclabs deniega `Describe*`/`GetMetricStatistics`; consola o sesión con permisos |

## 3. Criterios de terminado de B3

| Criterio de la HU | Evidencia | Estado | Última verificación |
| --- | --- | --- | --- |
| `terraform plan` sin errores | `terraform validate` OK; `apply` de la integración #45 + #46 + #47 + #44 en el Sandbox | Verificado (Sandbox) | 2026-11-12 |
| `apply` crea la tabla `ACTIVE` | Sandbox: tablas creadas; PITR `ENABLED` en `documents` y `document_events` | Verificado (Sandbox) | 2026-11-12 |
| `describe-table` muestra 2 GSI `ACTIVE` y `PAY_PER_REQUEST` | DynamoDB Local: `documents` y `document_events` ACTIVE, 2 GSIs ACTIVE, `PAY_PER_REQUEST`; Sandbox: tablas operativas | Verificado (local + Sandbox) | 2026-11-12 |
| `put-item` visible en `status-createdAt` con `status=PENDING` | DynamoDB Local: put-item + query devuelve el ítem PENDING; Sandbox: el worker tomó el documento PENDING | Verificado (local + Sandbox) | 2026-11-12 |
| Segundo `update-item` condicional falla | DynamoDB Local: primero OK, segundo `ConditionalCheckFailedException` (exit 254); Sandbox: transiciones del worker | Verificado (local + Sandbox) | 2026-11-12 |
| `TransactWriteItems` documento + evento es atómico | DynamoDB Local: transacción con condición fallida cancela todo; Sandbox: `POST /api/documents` 201 con `DDB_TRANSACTIONS=true` | Verificado (local + Sandbox) | 2026-11-12 |
| Consultas por `userId-eventAt` y `day-eventAt` | DynamoDB Local: ambas devuelven el evento de prueba | Verificado (local) | 2026-11-11 |
| Tabla `documents` con PK `documentId` y 2 GSIs | `infra/modules/dynamodb/main.tf` | Verificado (código) | 2026-11-11 |
| Tabla `document_events` append-only con 2 GSIs | `infra/modules/dynamodb/main.tf` | Verificado (código) | 2026-11-11 |
| Política de recurso con las acciones mínimas | `aws_dynamodb_resource_policy` en el módulo; Sandbox: políticas creadas tras quitar `dynamodb:TransactWriteItems` | Verificado (Sandbox) | 2026-11-12 |
| Endpoint de bitácora y alta transaccional | `app/api/src/documents.ts`, `aws.ts`; tests; Sandbox: trail `PENDING → PROCESSING → DONE` y 404 para otro usuario | Verificado (tests + Sandbox) | 2026-11-12 |
| `npm run typecheck`, `npm run build`, `npm test` | 68 pruebas en verde | Verificado | 2026-11-12 |
| ShellCheck del userData | `shellcheck` sobre las dos variantes renderizadas (provisional y con artefacto) | Verificado | 2026-11-11 |

## 4. Despliegue C3 (2026-11-13, cuenta 491699813584)

Rama `feat/C3-integracion-e2e-una-sola-cuenta`; PR #50 (Closes #16). Aplicado, probado y documentado en una sola cuenta Sandbox (con el perfil de credenciales del laboratorio):

- Apply desde estado vacío (`terraform init` + `plan -out=tfplan3.bin` → `68 to add, 0 change, 0 destroy`; `APPLY3_EXIT=0`): red (VPC vpc-0140c57f0081acafc, IGW, RTBs, 4 subnets, SGs, endpoints), S3 `docuprocess-dev-{artifacts,docs,frontend}-47cb5959` (PAB, SSE, versionado, CORS docs, política OAC frontend), RDS `docuprocess-dev-mysql` (db.t3.micro, single-AZ, `available`), DynamoDB `documents`/`document_events`, SNS `docuprocess-dev-alerts` + suscripción email a ingesoftv@gmail.com (confirmada; Terraform no puede confirmar correos de terceros), ALB `docuprocess-dev-alb` → TG `docuprocess-dev-app`, ASG `docuprocess-dev-app-v1` (2× t3.micro), Auth/API + worker en mismas instancias.
- Frontend de la sesión C3 original: CloudFront `d39ytkzrdg5rpz.cloudfront.net` (OAC → S3 + `/api/*` → ALB). `/` y `/api/health` → 200 (`{"status":"ok"}`). El entorno vigente tras la recreación de B9 usa `d3dsxrvmbdbzfq.cloudfront.net` (ver nota siguiente).
- E2E desde el navegador: registro/login, PDF DONE (pages=1), PNG DONE (1×1), PDF corrupto FAILED (`unsupported file type`), documentos de un usuario no visibles para otro (404). `document_events`: PENDING→PROCESSING→DONE sin duplicados.
- Tolerancia a fallo: `terminate-instances` de una instancia → ALB siguió 200 (la instancia restante servía), ASG la reemplazó (5xx transitorios ~1–4 min durante draining/registro, comportamiento esperado), target group quedó 2/2 healthy.
- ENTREGA: **viernes 13 de noviembre de 2026** (milestone "Entrega 13 nov"). C4 (#23) se cierra el 13 nov en cuenta limpia (entrega final).
- Pendiente/observaciones para A9: huérfanos sin tag que hicieron fallar la primera verificación de cuenta vacía (apply3 pasó solo tras borrarlos manualmente); tfstate de otra cuenta inconsistente → reset documentado (tfstate `.obsoleto-20261113`, previo `previa-20261112`); SNS exige confirmación manual del buzón (Terraform no puede confirmarla; verificado tras confirmar el correo); CloudFront 504 transitorio con draining; `voc-cancel-cred` a mitad de apply (credenciales voclabs revocadas, relanzar lab + re-plan/apply idempotente); `tfplan*.bin` nunca se commitean.
- **Recreación para B9 (2026-11-13):** el laboratorio volvió a quedar vacío; al validar B9 se refrescó el estado y se reaplicó el stack (**64 added, 0 changed, 3 destroyed**). IDs vigentes: VPC `vpc-076ffcf575b316a82`, ALB `docuprocess-dev-alb-40967399.us-east-1.elb.amazonaws.com`, CloudFront `d3dsxrvmbdbzfq.cloudfront.net` (distribución `E3GJW49EXZJ2LS`). La evidencia E2E anterior corresponde a la sesión previa de C3; B9 valida la publicación y la invalidación sobre el entorno recreado.

## 5. Criterios de terminado de B9

| Criterio de la HU | Evidencia | Estado | Última verificación |
| --- | --- | --- | --- |
| `./scripts/deploy-frontend.sh` termina sin errores e imprime la URL | `AWS_PROFILE=academy ./scripts/deploy-frontend.sh` → exit 0; última línea `https://d3dsxrvmbdbzfq.cloudfront.net/`; invalidación `I84XG4B6TMFJ6QIF442PVQEO2F` `Completed` | Verificado (Sandbox) | 2026-11-13 |
| Un cambio visible en `index.html` aparece en CloudFront tras la invalidación | Marcador `B9-CHECK-SOURCE-2026-11-13T15:05Z` en el fuente → script → invalidación `I6ZD0LMFTHYWIIDT2AAVL6MS1A` `Completed`; `curl` devuelve el marcador. Restauración `I2T0D148DBN71IL0Z55Y8VUT7D`; marcador ausente | Verificado (Sandbox) | 2026-11-13 |
| El bucket no contiene `config.example.js` y sí `config.js` | `config.js` presente (300 bytes); `config.example.js` ausente; cabeceras verificadas con `head-object` | Verificado (Sandbox) | 2026-11-13 |
| Con credenciales vencidas, el script falla al inicio con un mensaje claro | `InvalidClientTokenId` en `aws sts get-caller-identity`, antes de Terraform/npm/S3 | Verificado (local) | 2026-11-13 |
| `bash -n`, ShellCheck y build de Vite | `bash -n` y `shellcheck scripts/*.sh` OK; `npm ci` + `npm run build` OK; CI del PR #52 en verde | Verificado (local + CI) | 2026-11-13 |

**Estado:** B9 cerrado. El script se validó con `AWS_PROFILE=academy` (cuenta `491699813584`). El perfil `default` de la máquina apunta a `556880009270` y el script falla de forma segura antes de escribir si la cuenta no coincide con el estado.

## 6. Riesgos abiertos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| SCP deniega `dynamodb:PutResourcePolicy` | El rol no puede leer/escribir las tablas | No hay plan B sin IAM propio; habría que escalar el permiso al administrador del Sandbox |
| SCP deniega las escrituras transaccionales (acciones de ítem como `PutItem`/`UpdateItem`) | El alta no es atómica | `enable_dynamodb_transactions = false` (escritura secuencial; deuda documentada en §12) |
| Sandbox deniega `point_in_time_recovery` | Sin restauración a un segundo | `enable_point_in_time_recovery = false` |
| El worker aún no está fusionado en `main` | No hay transiciones `PROCESSING/DONE/FAILED` en la rama base | B5/B6 integran el worker; la bitácora ya tiene el contrato y el endpoint |
| Fechas y horas reales de la tarea | El tablero puede quedar desactualizado | Issue #7 actualizada al cerrar (formato `YYYY-MM-DD`); el Project no es visible con el token actual |
| Reinicio del laboratorio borra recursos y deja el estado obsoleto | `plan/apply` y el despliegue fallan o apuntan a recursos inexistentes | Usar `AWS_PROFILE=academy`; refrescar el estado (`plan -refresh=true`) y reaplicar; el script valida la cuenta y falla antes de escribir si no coincide |
| `infra/terraform.tfvars` no se versiona (existe localmente) | El despliegue no es reproducible solo con el repo | Copiar `terraform.tfvars.example`, completar secretos y correo, y mantenerlo fuera de Git |

## 7. Cómo reproducir la verificación

```bash
# En el Sandbox, usar el perfil del laboratorio (cuenta 491699813584)
export AWS_PROFILE=academy

# Infraestructura
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate

# API
cd app/api
npm ci
npm run typecheck
npm run build
npm test

# DynamoDB Local (esquema idéntico al de Terraform; comandos en architecture.md, 13)
docker compose up -d dynamodb
# ... create-table de documents y document_events ...

# AWS (con credenciales de la cuenta correcta y terraform.tfvars)
terraform -chdir=infra plan
terraform -chdir=infra apply
aws dynamodb describe-table --table-name documents --query 'Table.[TableStatus,BillingModeSummary.BillingMode]'
aws dynamodb describe-table --table-name document_events --query 'Table.[TableStatus,BillingModeSummary.BillingMode]'

# Frontend (B9): build, S3, cabeceras e invalidación
./scripts/deploy-frontend.sh
BUCKET="$(terraform -chdir=infra output -raw frontend_bucket_name)"
aws s3 ls "s3://$BUCKET/"
aws s3api head-object --bucket "$BUCKET" --key config.js --query '[CacheControl,ContentType]'
```
