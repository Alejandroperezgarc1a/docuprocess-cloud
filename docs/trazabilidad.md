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
| 1 | VPC con subredes públicas (ALB) y privadas (app + datos) | `infra/modules/network/`; `terraform validate` | Implementado | 2026-11-11 | Falta `plan/apply` en la cuenta del Sandbox |
| 2 | ALB + ASG 2–4, `t3.micro` | `infra/modules/compute/`; salidas `alb_dns_name`, `asg_name` | Implementado | 2026-11-11 | Prueba de carga (A8) pendiente |
| 3 | API y worker en las mismas instancias | `scripts/user-data.sh.tftpl` (unidades `docuprocess-api` y `docuprocess-worker`) | Implementado | 2026-11-11 | `app/worker/` aún no existe: el userData solo crea la unidad si el artefacto trae worker |
| 4 | SSM Session Manager, sin SSH ni bastión | `data "aws_iam_instance_profiles"`; rol preexistente; sin key pair | Implementado | 2026-11-11 | El Sandbox no permite crear roles: solo se usa `AmazonSSMRoleForInstancesQuickSetup` |
| 5 | RDS MySQL Single-AZ `db.t3.micro` para cuentas y autenticación | `infra/modules/rds/`; `db/multi_az = false`; `gp2` 20 GB | Implementado | 2026-11-11 | Sin `apply` no se ha visto la instancia `available` |
| 6 | S3 para archivos | Bucket de documentos + URL prefirmada (`app/api/src/aws.ts`) | Pendiente B2 | 2026-11-11 | `module.storage` aún no está en `main.tf`; el userData usa el servidor provisional |
| 7 | DynamoDB para metadatos, historial y resultados | `infra/modules/dynamodb/` (dos tablas, 4 GSIs, 2 políticas); pruebas CLI en DynamoDB Local | Implementado (verificado en local) | 2026-11-11 | **Objeto de B3**; falta `apply` en la cuenta del Sandbox |
| 8 | SNS para notificaciones | `module.sns` previsto (B6) | Pendiente B6 | 2026-11-11 | El userData ya recibe `SNS_TOPIC_ARN` (vacío hasta B6) |
| 9 | CloudWatch: alarmas de CPU de EC2 y métricas de RDS | Módulo `monitoring` previsto (B9) | Pendiente B9 | 2026-11-11 | — |
| 10 | CloudTrail para auditoría | Módulo `monitoring` previsto (B9) | Pendiente B9 | 2026-11-11 | — |
| 11 | IaC modular (Terraform) | `infra/main.tf` + `infra/modules/{network,compute,rds,dynamodb}` | Implementado | 2026-11-11 | Módulos storage/sns/cdn/monitoring pendientes de sus tareas |
| 12 | Sin `CreateRole`/`GetRole`; solo roles preexistentes | `data.aws_iam_instance_profiles` + políticas basadas en recursos | Verificado | 2026-11-11 | — |
| 13 | EC2 `t2/t3`, máximo 9 concurrentes, EBS `gp2` ≤ 35 GB | `var.instance_type` y `var.root_volume_size` con validaciones | Verificado | 2026-11-11 | — |
| 14 | RDS `gp2` ≤ 100 GB, Single-AZ | `infra/modules/rds/main.tf` | Verificado | 2026-11-11 | — |
| 15 | Comparativa RDS vs. DynamoDB | `docs/rds-vs-dynamodb.md` | Verificado | 2026-11-11 | — |
| 16 | Diagrama detallado y flujo | `README.md` (componentes) y `docs/architecture.md` §4.1 (datos) | Implementado | 2026-11-11 | El diagrama completo con la tabla de eventos es B10 |
| 17 | Guía de despliegue y troubleshooting | README (mínimo) | Pendiente A9 | 2026-11-11 | — |
| 18 | Demo: subida S3 → worker → DynamoDB → SNS | API + worker + tablas | Pendiente B5/B6 | 2026-11-11 | El worker y SNS aún no están implementados |
| 19 | Prueba de carga para el ASG | Scripts previstos (A8) | Pendiente A8 | 2026-11-11 | — |

## 3. Criterios de terminado de B3

| Criterio de la HU | Evidencia | Estado | Última verificación |
| --- | --- | --- | --- |
| `terraform plan` sin errores | `terraform validate` OK; `plan` bloqueado por estado de otra cuenta y falta de `terraform.tfvars` | Pendiente (credenciales) | 2026-11-11 |
| `apply` crea la tabla `ACTIVE` | Pendiente de credenciales de la cuenta correcta | Pendiente | 2026-11-11 |
| `describe-table` muestra 2 GSI `ACTIVE` y `PAY_PER_REQUEST` | DynamoDB Local: `documents` y `document_events` ACTIVE, 2 GSIs ACTIVE, `PAY_PER_REQUEST`; falta AWS | Verificado (local) | 2026-11-11 |
| `put-item` visible en `status-createdAt` con `status=PENDING` | DynamoDB Local: put-item + query devuelve el ítem PENDING | Verificado (local) | 2026-11-11 |
| Segundo `update-item` condicional falla | DynamoDB Local: primero OK, segundo `ConditionalCheckFailedException` (exit 254) | Verificado (local) | 2026-11-11 |
| `TransactWriteItems` documento + evento es atómico | DynamoDB Local: transacción con condición fallida cancela todo y no escribe el evento | Verificado (local) | 2026-11-11 |
| Consultas por `userId-eventAt` y `day-eventAt` | DynamoDB Local: ambas devuelven el evento de prueba | Verificado (local) | 2026-11-11 |
| Tabla `documents` con PK `documentId` y 2 GSIs | `infra/modules/dynamodb/main.tf` | Verificado (código) | 2026-11-11 |
| Tabla `document_events` append-only con 2 GSIs | `infra/modules/dynamodb/main.tf` | Verificado (código) | 2026-11-11 |
| Política de recurso con las acciones mínimas | `aws_dynamodb_resource_policy` en el módulo | Verificado (código) | 2026-11-11 |
| Endpoint de bitácora y alta transaccional | `app/api/src/documents.ts`, `aws.ts`; tests | Verificado (tests) | 2026-11-11 |
| `npm run typecheck`, `npm run build`, `npm test` | 67 pruebas en verde | Verificado | 2026-11-11 |
| ShellCheck del userData | `shellcheck` sobre las dos variantes renderizadas (provisional y con artefacto) | Verificado | 2026-11-11 |

## 4. Riesgos abiertos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| SCP deniega `dynamodb:PutResourcePolicy` | El rol no puede leer/escribir las tablas | No hay plan B sin IAM propio; habría que escalar el permiso al administrador del Sandbox |
| SCP deniega `dynamodb:TransactWriteItems` | El alta no es atómica | `enable_dynamodb_transactions = false` (escritura secuencial; deuda documentada en §12) |
| Sandbox deniega `point_in_time_recovery` | Sin restauración a un segundo | `enable_point_in_time_recovery = false` |
| El worker todavía no existe | No hay transiciones `PROCESSING/DONE/FAILED` ni historial real | B5/B6 implementan el worker; la bitácora ya tiene el contrato y el endpoint |
| Fechas y horas reales de la tarea | El tablero puede quedar desactualizado | Issue #7 actualizada al cerrar (formato `YYYY-MM-DD`); el Project no es visible con el token actual |
| Estado local de Terraform de otra cuenta (`491699813584`) | `plan/apply` falla con las credenciales actuales (`556880009270`) | Usar el estado de la cuenta correcta o `terraform state rm`/importar; nunca aplicar sobre un estado ajeno |
| No existe `infra/terraform.tfvars` | El despliegue no es reproducible solo con el repo | Copiar `terraform.tfvars.example`, completar secretos y correo, y mantenerlo fuera de Git |

## 5. Cómo reproducir la verificación

```bash
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
```
