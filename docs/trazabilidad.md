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
| 1 | VPC con subredes públicas (ALB) y privadas (app + datos) | `infra/modules/network/`; apply en cuenta <AWS_ACCOUNT_ID> OK | Verificado | 2026-11-13 | Aplicado desde estado vacío (apply3) |
| 2 | ALB + ASG 2–4, `t3.micro` | apply OK: 2 instancias InService/Healthy; drill terminación → reemplazo ASG; 2/2 healthy; A8: escalado real 2→4 bajo carga (CPU 98-99 %) | Verificado | 2026-11-13 | Escaló a 4 tras la prueba de carga (CPU objetivo 60 %); scale-in automático a 2 en ~15 min |
| 3 | API y worker en las mismas instancias | `docuprocess-api` y `docuprocess-worker` `active` en AMBAS instancias vía SSM (2026-11-13) | Verificado | 2026-11-13 | — |
| 4 | SSM Session Manager, sin SSH ni bastión | `/etc/docuprocess.env` real completo en ambas instancias vía send-command; API/worker active | Verificado | 2026-11-13 | Rol preexistente (AmazonSSMRoleForInstancesQuickSetup) |
| 5 | RDS MySQL Single-AZ `db.t3.micro` para cuentas y autenticación | apply OK: docuprocess-dev-mysql db.t3.micro disponible (endpoint <RDS_ENDPOINT_ID>) | Verificado | 2026-11-13 | — |
| 6 | S3 para archivos | apply OK: buckets docuprocess-dev-{docs,frontend,artifacts}-<BUCKET_SUFFIX> con PAB/SSE/versioning/CORS/OAC; subida PUT prefirmada OK (3/3) | Verificado | 2026-11-13 | — |
| 7 | DynamoDB para metadatos, historial y resultados | apply OK: tablas ACTIVE; document_events: PENDING→PROCESSING→DONE sin duplicados (3/3 docs) | Verificado | 2026-11-13 | — |
| 8 | SNS para notificaciones | apply OK: topic docuprocess-dev-alerts + suscripción email `<TEAM_EMAIL>` confirmada; worker `sns_published` (DONE) y CloudWatch `Delivered=3`, `Failed=0` | Verificado | 2026-11-13 | Terraform no puede confirmar la suscripción: la confirmación del buzón es manual (una vez) |
| 9 | CloudWatch: alarmas de CPU de EC2 y métricas de RDS | Verificación viva 2026-11-13 (sesión de entrega): las 4 alarmas (`docuprocess-dev-ec2-cpu-high`, `rds-cpu-high`, `rds-connections-high`, `rds-free-storage-low`) en estado `OK` con 1 acción hacia el SNS `docuprocess-dev-alerts` (suscripción `<TEAM_EMAIL>` confirmada); ASG `docuprocess-dev-app-v1` 2/2 InService antes de la prueba de carga (4/4 durante A8); TG `docuprocess-dev-app` 2/2 healthy | Verificado | 2026-11-13 | durante la prueba de carga A8 el ASG escaló 2→4 (ver fila 19) |
| 10 | CloudTrail para auditoría | Verificación viva 2026-11-13: `cloudtrail` sin trails; modo `event-history` (90 días, `verify-cloudtrail.sh`) OK; `describe-trails` permitió confirmar que no hay trail | Verificado | 2026-11-13 | Sandbox deniega `cloudtrail:CreateTrail`; sin trail persistente (documentado en esta matriz) |
| 11 | IaC modular (Terraform) | apply desde estado vacío OK: Plan 68 to add, 68/68, APPLY3_EXIT=0 (integración); con `monitoring` el plan actual es del orden de 73 recursos; módulos network/storage/dynamodb/rds/compute/sns/cdn + monitoring (PR #51) | Verificado | 2026-11-13 | — |
| 12 | Sin `CreateRole`/`GetRole`; solo roles preexistentes | `data.aws_iam_instance_profiles` + políticas basadas en recursos | Verificado | 2026-11-11 | — |
| 13 | EC2 `t2/t3`, máximo 9 concurrentes, EBS `gp2` ≤ 35 GB | `var.instance_type` y `var.root_volume_size` con validaciones | Verificado | 2026-11-11 | — |
| 14 | RDS `gp2` ≤ 100 GB, Single-AZ | `infra/modules/rds/main.tf` | Verificado | 2026-11-11 | — |
| 15 | Comparativa RDS vs. DynamoDB | `docs/rds-vs-dynamodb.md` | Verificado | 2026-11-11 | — |
| 16 | Diagrama detallado y flujo | `README.md` (diagrama de componentes) y `docs/architecture.md` §1 (diagrama detallado, flujo del documento y tabla de componentes/eventos) | Verificado | 2026-11-13 | — |
| 17 | Guía de despliegue y troubleshooting | `docs/guias/despliegue-automatizado-sandbox.md` y `.pdf` (preflight del Sandbox, despliegue automatizado, verificación E2E por capas, importación de huérfanos y tabla de casos frecuentes); guía rápida en `docs/guias/despliegue.md` | Verificado | 2026-11-13 | — |
| 18 | Demo: subida S3 → worker → DynamoDB → SNS | Flujo E2E 2026-11-13 (vía CloudFront): registro/login; PDF→DONE pages=1; PNG→DONE width/height=1; corrupt.pdf→FAILED unsupported file type; doc ajeno 404; correo SNS por documento | Verificado | 2026-11-13 | — |
| 19 | Prueba de carga para el ASG | Verificado en dos corridas: 2026-11-11 (6677 logins, ASG 2→3→4, CPU 100 %, 1.0 % errores) y 2026-11-13 (`scripts/load-test.sh`, sesión de entrega): CPU 98-99 % saturada desde +162 s; ASG `docuprocess-dev-app-v1` escaló 2→4 a los +333 s (18:04Z, `Successful: Launching a new EC2 instance` ×2); 600 s, concurrencia 50, 5848 requests, 32 fallidos, 4 no-2xx | Verificado | 2026-11-13 | scale-in a 2 requiere ~15 min de CPU baja (AlarmLow); 4 no-2xx transitorios durante el escalado |

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
| Metadatos técnicos completos, resumen y vista previa | Worker: PDF (versión, páginas, tamaños, autor/título/fechas), TXT (BOM/CRLF, estadísticas, resumen), PNG; API: `GET /api/documents/{id}/download` con 200/404/409/503; frontend: línea de vida, resumen, preview y metadatos | Verificado (102 pruebas: 72 API + 30 worker) | 2026-11-13 |
| ShellCheck del userData | `shellcheck` sobre las dos variantes renderizadas (provisional y con artefacto) | Verificado | 2026-11-11 |

## 4. Despliegue C3 (2026-11-13, cuenta `<AWS_ACCOUNT_ID>`)

Rama `feat/C3-integracion-e2e-una-sola-cuenta`; PR #50 (Closes #16). Aplicado, probado y documentado en una sola cuenta Sandbox (con el perfil de credenciales del laboratorio):

- Apply desde estado vacío (`terraform init` + `plan -out=tfplan3.bin` → `68 to add, 0 change, 0 destroy`; `APPLY3_EXIT=0`): red (VPC <VPC_ID>, IGW, RTBs, 4 subnets, SGs, endpoints), S3 `docuprocess-dev-{artifacts,docs,frontend}-<BUCKET_SUFFIX>` (PAB, SSE, versionado, CORS docs, política OAC frontend), RDS `docuprocess-dev-mysql` (db.t3.micro, single-AZ, `available`), DynamoDB `documents`/`document_events`, SNS `docuprocess-dev-alerts` + suscripción email a `<TEAM_EMAIL>` (confirmada; Terraform no puede confirmar correos de terceros), ALB `docuprocess-dev-alb` → TG `docuprocess-dev-app`, ASG `docuprocess-dev-app-v1` (2× t3.micro), Auth/API + worker en mismas instancias.
- Frontend de la sesión C3 original: CloudFront `<CLOUDFRONT_DOMAIN_C3>` (OAC → S3 + `/api/*` → ALB). `/` y `/api/health` → 200 (`{"status":"ok"}`). El entorno vigente tras la recreación de B9 usa `<CLOUDFRONT_DOMAIN>` (ver nota siguiente).
- E2E desde el navegador: registro/login, PDF DONE (pages=1), PNG DONE (1×1), PDF corrupto FAILED (`unsupported file type`), documentos de un usuario no visibles para otro (404). `document_events`: PENDING→PROCESSING→DONE sin duplicados.
- Tolerancia a fallo: `terminate-instances` de una instancia → ALB siguió 200 (la instancia restante servía), ASG la reemplazó (5xx transitorios ~1–4 min durante draining/registro, comportamiento esperado), target group quedó 2/2 healthy.
- ENTREGA: **viernes 13 de noviembre de 2026** (milestone "Entrega 13 nov"). C4 (#23) se cierra el 13 nov en cuenta limpia (entrega final).
- Pendiente/observaciones para A9: huérfanos sin tag que hicieron fallar la primera verificación de cuenta vacía (apply3 pasó solo tras borrarlos manualmente); tfstate de otra cuenta inconsistente → reset documentado (tfstate `.obsoleto-20261113`, previo `previa-20261112`); SNS exige confirmación manual del buzón (Terraform no puede confirmarla; verificado tras confirmar el correo); CloudFront 504 transitorio con draining; `voc-cancel-cred` a mitad de apply (credenciales voclabs revocadas, relanzar lab + re-plan/apply idempotente); `tfplan*.bin` nunca se commitean.
- **Recreación para B9 (2026-11-13):** el laboratorio volvió a quedar vacío; al validar B9 se refrescó el estado y se reaplicó el stack (**64 added, 0 changed, 3 destroyed**). IDs vigentes: VPC `<VPC_ID_2>`, ALB `<ALB_DNS>`, CloudFront `<CLOUDFRONT_DOMAIN>` (distribución `<CLOUDFRONT_DISTRIBUTION_ID>`). La evidencia E2E anterior corresponde a la sesión previa de C3; B9 valida la publicación y la invalidación sobre el entorno recreado.

## 5. Criterios de terminado de B9

| Criterio de la HU | Evidencia | Estado | Última verificación |
| --- | --- | --- | --- |
| `./scripts/deploy-frontend.sh` termina sin errores e imprime la URL | `AWS_PROFILE=academy ./scripts/deploy-frontend.sh` → exit 0; última línea `https://<CLOUDFRONT_DOMAIN>/`; invalidación `<INVALIDATION_ID>` `Completed` | Verificado (Sandbox) | 2026-11-13 |
| Un cambio visible en `index.html` aparece en CloudFront tras la invalidación | Marcador `B9-CHECK-SOURCE-2026-11-13T15:05Z` en el fuente → script → invalidación `<INVALIDATION_ID_2>` `Completed`; `curl` devuelve el marcador. Restauración `<INVALIDATION_ID_RESTORE>`; marcador ausente | Verificado (Sandbox) | 2026-11-13 |
| El bucket no contiene `config.example.js` y sí `config.js` | `config.js` presente (300 bytes); `config.example.js` ausente; cabeceras verificadas con `head-object` | Verificado (Sandbox) | 2026-11-13 |
| Con credenciales vencidas, el script falla al inicio con un mensaje claro | `InvalidClientTokenId` en `aws sts get-caller-identity`, antes de Terraform/npm/S3 | Verificado (local) | 2026-11-13 |
| `bash -n`, ShellCheck y build de Vite | `bash -n` y `shellcheck scripts/*.sh` OK; `npm ci` + `npm run build` OK; CI del PR #52 en verde | Verificado (local + CI) | 2026-11-13 |

**Estado:** B9 cerrado. El script se validó con `AWS_PROFILE=academy` (cuenta `<AWS_ACCOUNT_ID>`). El perfil `default` de la máquina apunta a `<OTHER_AWS_ACCOUNT_ID>` y el script falla de forma segura antes de escribir si la cuenta no coincide con el estado.

## 6. Riesgos abiertos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| SCP deniega `dynamodb:PutResourcePolicy` | El rol no puede leer/escribir las tablas | No hay plan B sin IAM propio; habría que escalar el permiso al administrador del Sandbox |
| Una política llegara a denegar las escrituras de ítems de la transacción (`PutItem`/`UpdateItem`) | El alta no es atómica | `enable_dynamodb_transactions = false` (escritura secuencial; deuda documentada en §12). En el Sandbox no ocurre: las transacciones funcionan |
| Sandbox deniega `point_in_time_recovery` | Sin restauración a un segundo | `enable_point_in_time_recovery = false` |
| El worker aún no está fusionado en `main` | No hay transiciones `PROCESSING/DONE/FAILED` en la rama base | B5/B6 integran el worker; la bitácora ya tiene el contrato y el endpoint |
| Fechas y horas reales de la tarea | El tablero puede quedar desactualizado | Issue #7 actualizada al cerrar (formato `YYYY-MM-DD`); el Project no es visible con el token actual |
| Reinicio del laboratorio borra recursos y deja el estado obsoleto | `plan/apply` y el despliegue fallan o apuntan a recursos inexistentes | Usar `AWS_PROFILE=academy`; refrescar el estado (`plan -refresh=true`) y reaplicar; el script valida la cuenta y falla antes de escribir si no coincide |
| `infra/terraform.tfvars` no se versiona (existe localmente) | El despliegue no es reproducible solo con el repo | Copiar `terraform.tfvars.example`, completar secretos y correo, y mantenerlo fuera de Git |

## 7. Cómo reproducir la verificación

```bash
# En el Sandbox, usar el perfil del laboratorio (cuenta `<AWS_ACCOUNT_ID>`)
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
