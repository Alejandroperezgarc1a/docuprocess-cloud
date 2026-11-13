# Informe de cierre — B3: módulo DynamoDB y bitácora auditable

| Campo | Valor |
| --- | --- |
| Rama | `feat/B3-modulo-DynamoDB` |
| Fecha | 2026-11-12 (UTC) |
| Alcance | Tablas `documents` y `document_events`, políticas de recurso, integración en la API, endpoint de bitácora, contrato y comparativa |
| Estado | Implementado y verificado en local y en el Sandbox de AWS (integración #45 + #46 + #47 + #44) |

## 1. Qué se hizo

La HU B3 pedía la tabla `documents` (estado y cola del worker). Se implementó además una
**bitácora auditable** en una segunda tabla, `document_events`, aprobada durante el diseño:

- `documents`: PK `documentId`; GSI `userId-createdAt` (lista por usuario) y `status-createdAt`
  (cola del worker); on-demand; cifrado con llave administrada por AWS; PITR; sin protección
  contra borrado (laboratorio).
- `document_events`: PK `documentId` + SK `eventAt`; GSI `userId-eventAt` y `day-eventAt`;
  append-only; misma configuración de capacidad, cifrado y respaldo.
- Políticas de recurso para el rol preexistente de las instancias: la tabla de documentos permite
  `GetItem`, `PutItem`, `UpdateItem` y `Query`; la de eventos permite `GetItem`, `PutItem` y
  `Query`, de modo que la aplicación no puede reescribir el historial. Las transacciones se
  autorizan con las acciones de cada ítem; `dynamodb:TransactWriteItems` **no** es una acción IAM
  válida y se eliminó de ambas políticas durante la validación en AWS.
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
| `npm test` | 68 pruebas, 68 en verde |
| ShellCheck del userData (dos variantes renderizadas) | Correcto |
| AWS Sandbox: `apply` de políticas y PITR | Ambas políticas creadas; PITR `ENABLED` en `documents` y `document_events` |
| AWS Sandbox: alta transaccional | `POST /api/documents` 201 con `DDB_TRANSACTIONS=true`; `PUT` a S3 200 |
| AWS Sandbox: worker y bitácora | Documento `DONE` con `mimeType`, `sha256` y `sizeBytes`; eventos `PENDING → PROCESSING → DONE` en orden |
| AWS Sandbox: aislamiento y SNS | Bitácora de otro usuario 404; log `sns_published` |
| DynamoDB Local: `describe-table` | `documents` y `document_events` ACTIVE, `PAY_PER_REQUEST`, 2 GSIs ACTIVE cada una |
| DynamoDB Local: `put-item` + query `status-createdAt` | Devuelve el documento PENDING |
| DynamoDB Local: update condicional | Primero OK; segundo `ConditionalCheckFailedException` |
| DynamoDB Local: `TransactWriteItems` | Documento + evento confirmados; transacción con condición fallida no escribe nada |
| DynamoDB Local: GSIs de eventos | `userId-eventAt` y `day-eventAt` devuelven el evento |

Detalle de la semántica de las condiciones: la clave del evento es compuesta
(`documentId` + `eventAt`), por lo que `attribute_not_exists(eventAt)` protege la clave exacta del
evento y no limita los demás eventos del documento. La condición del documento
(`attribute_not_exists(documentId)`) es la que impide sobrescribir un documento existente.

## 4. Validación en AWS (2026-11-12)

El `apply` se validó en el Sandbox con la integración de #45 + #46 + #47 + #44 sobre `main`. El
primer intento falló al crear las dos políticas de recurso:

```text
api error ValidationException: Invalid policy document:
The following action names are invalid: "dynamodb:TransactWriteItems"
```

`TransactWriteItems` no es una acción IAM: DynamoDB autoriza la transacción con las acciones de
cada ítem (`PutItem`, `UpdateItem`, `ConditionCheckItem`, `DeleteItem`). Se eliminó de ambas
políticas —la API hace Put + Put y el worker Update + Put, ya permitidos— y se corrigió esta
documentación. Con ese cambio pasó todo:

- Ambas políticas se crearon y PITR quedó `ENABLED` en las dos tablas.
- `register` 201, `login` 200, `POST /api/documents` 201 y `PUT` a S3 200.
- El worker movió el documento a `DONE` en ~10 s con `mimeType`, `sha256` y `sizeBytes`.
- `GET /api/documents/{id}/events` devolvió `- → PENDING (api)`, `PENDING → PROCESSING (worker)`
  y `PROCESSING → DONE (worker)` en orden.
- El mismo trail con el token de otro usuario devolvió 404.
- El log del worker registró `sns_published` con el topic de #47.

La validación se hizo sobre la integración de ramas, que es el escenario real de despliegue; no se
repitió un `apply` aislado solo con B3.

## 5. Fechas y horas

- Issue #7 (B3): trabajo local `2026-11-11`; validación en AWS `2026-11-12`. Horas reales
  estimadas: **5** (la HU estimaba 3; el extra corresponde al diseño de la bitácora, la
  comparativa y la verificación local).
- `docs/trazabilidad.md`: columna `Última verificación` actualizada a `2026-11-12`.
- No hay GitHub Project visible para el token actual (`gh project list` devuelve 0 proyectos); la
  issue sí quedó actualizada.

## 6. Pendientes

1. Repetir un `apply` aislado de B3 si se quiere evidencia separada de la integración; el Sandbox
   ya validó las políticas, PITR y el flujo completo con las ramas integradas.
2. Implementar el worker (B5/B6) para producir transiciones `PROCESSING/DONE/FAILED` en la bitácora.
3. B2/B4/B6/B10: storage, SNS, alarmas y diagrama completo.
4. Prueba de carga (A8) y guía de despliegue (A9).

## 7. Commits sugeridos

1. `feat(dynamodb): B3 tabla documents on-demand con PK documentId`
2. `feat(dynamodb): B3 GSI userId-createdAt y status-createdAt`
3. `feat(dynamodb): B3 document_events append-only y transacciones`
4. `feat(api): B3 alta transaccional y endpoint de bitacora`
5. `docs: B3 contrato, diagrama de datos y comparativa RDS vs DynamoDB`
6. `docs: B3 trazabilidad, informe y guia de aprendizaje`
7. `fix(dynamodb): B3 elimina la accion IAM invalida TransactWriteItems`
8. `fix(api): B3 reconoce la ruta de eventos en KNOWN_ROUTES`
