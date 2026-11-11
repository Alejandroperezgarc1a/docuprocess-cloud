# Informe de cierre — B3: módulo DynamoDB y bitácora auditable

| Campo | Valor |
| --- | --- |
| Rama | `feat/B3-modulo-DynamoDB` |
| Fecha | 2026-11-11 (UTC) |
| Alcance | Tablas `documents` y `document_events`, políticas de recurso, integración en la API, endpoint de bitácora, contrato y comparativa |
| Estado | Implementado y verificado en local. `apply` en AWS pendiente por credenciales/estado de otra cuenta |

## 1. Qué se hizo

La HU B3 pedía la tabla `documents` (estado y cola del worker). Se implementó además una
**bitácora auditable** en una segunda tabla, `document_events`, aprobada durante el diseño:

- `documents`: PK `documentId`; GSI `userId-createdAt` (lista por usuario) y `status-createdAt`
  (cola del worker); on-demand; cifrado con llave administrada por AWS; PITR; sin protección
  contra borrado (laboratorio).
- `document_events`: PK `documentId` + SK `eventAt`; GSI `userId-eventAt` y `day-eventAt`;
  append-only; misma configuración de capacidad, cifrado y respaldo.
- Políticas de recurso para el rol preexistente de las instancias: la tabla de documentos permite
  `GetItem`, `PutItem`, `UpdateItem`, `Query` y `TransactWriteItems`; la de eventos permite lo
  mismo salvo `UpdateItem`/`DeleteItem`, de modo que la aplicación no puede reescribir el historial.
- El alta de un documento escribe estado + evento inicial `PENDING` en una sola transacción
  (`TransactWriteItems`). Si el Sandbox deniega transacciones, `DDB_TRANSACTIONS=false` activa el
  fallback secuencial documentado.
- Nuevo endpoint `GET /api/documents/{id}/events`, con validación de UUID, comprobación de
  propiedad (404 para otro usuario) y 503 si DynamoDB falla.
- Contrato C1 actualizado y nueva comparativa obligatoria RDS vs. DynamoDB.

## 2. Archivos

| Área | Archivos |
| --- | --- |
| Infraestructura | `infra/modules/dynamodb/{main,variables,outputs}.tf`, `infra/main.tf`, `infra/variables.tf`, `infra/outputs.tf` |
| Configuración de instancias | `scripts/user-data.sh.tftpl` (`DDB_TABLE`, `DDB_EVENTS_TABLE`, `DDB_TRANSACTIONS`) |
| API | `app/api/src/{types,config,aws,documents,openapi}.ts`; tests en `app/api/tests/` |
| Documentación | `docs/architecture.md` (§3, §4.1, §7, §10–§13), `docs/rds-vs-dynamodb.md`, `docs/trazabilidad.md`, `README.md`, `app/api/README.md`, `.env.example` |

## 3. Verificación ejecutada

| Prueba | Resultado |
| --- | --- |
| `terraform fmt -recursive` + `init -backend=false` + `validate` | Correcto |
| `npm run typecheck` | Correcto |
| `npm run build` | Correcto |
| `npm test` | 67 pruebas, 67 en verde |
| ShellCheck del userData (dos variantes renderizadas) | Correcto |
| DynamoDB Local: `describe-table` | `documents` y `document_events` ACTIVE, `PAY_PER_REQUEST`, 2 GSIs ACTIVE cada una |
| DynamoDB Local: `put-item` + query `status-createdAt` | Devuelve el documento PENDING |
| DynamoDB Local: update condicional | Primero OK; segundo `ConditionalCheckFailedException` |
| DynamoDB Local: `TransactWriteItems` | Documento + evento confirmados; transacción con condición fallida no escribe nada |
| DynamoDB Local: GSIs de eventos | `userId-eventAt` y `day-eventAt` devuelven el evento |

Detalle de la semántica de las condiciones: la clave del evento es compuesta
(`documentId` + `eventAt`), por lo que `attribute_not_exists(eventAt)` protege la clave exacta del
evento y no limita los demás eventos del documento. La condición del documento
(`attribute_not_exists(documentId)`) es la que impide sobrescribir un documento existente.

## 4. Bloqueo para el `apply` en AWS

No se ejecutó `apply`. Las credenciales disponibles (`aws sts get-caller-identity`) pertenecen a la
cuenta **556880009270**, pero el estado local de Terraform corresponde a la cuenta
**491699813584**. Además:

- No existe `infra/terraform.tfvars` (solo el `.example`).
- La SCP deniega `ec2:DescribeImages`.
- El rol/instance profile `AmazonSSMRoleForInstancesQuickSetup` no existe en la cuenta actual.

`terraform plan` llegó a proponer 40 recursos y falló en los `data` de AMI e instance profile.
Aplicar sobre ese estado mezclaría recursos de dos cuentas; no se hizo.

**Cómo desbloquearlo:** copiar las credenciales de la cuenta correcta del Sandbox (o limpiar el
estado local si se empieza de cero), crear `infra/terraform.tfvars` a partir del ejemplo y ejecutar
`terraform -chdir=infra plan` antes de `apply`.

## 5. Fechas y horas

- Issue #7 (B3): fechas reales `2026-11-11 – 2026-11-11`; horas reales estimadas: **5** (la HU
  estimaba 3; el extra corresponde al diseño de la bitácora, la comparativa y la verificación local).
- `docs/trazabilidad.md`: columna `Última verificación` con `2026-11-11`.
- No hay GitHub Project visible para el token actual (`gh project list` devuelve 0 proyectos); la
  issue sí quedó actualizada.

## 6. Pendientes

1. `terraform apply` en la cuenta correcta y repetir los criterios de la HU contra AWS.
2. Implementar el worker (B5/B6) para producir transiciones `PROCESSING/DONE/FAILED` en la bitácora.
3. B2/B4/B6/B9/B10: storage, SNS, alarmas y diagrama completo.
4. Prueba de carga (A8) y guía de despliegue (A9).

## 7. Commits sugeridos

1. `feat(dynamodb): B3 tabla documents on-demand con PK documentId`
2. `feat(dynamodb): B3 GSI userId-createdAt y status-createdAt`
3. `feat(dynamodb): B3 document_events append-only y transacciones`
4. `feat(api): B3 alta transaccional y endpoint de bitacora`
5. `docs: B3 contrato, diagrama de datos y comparativa RDS vs DynamoDB`
6. `docs: B3 trazabilidad, informe y guia de aprendizaje`
