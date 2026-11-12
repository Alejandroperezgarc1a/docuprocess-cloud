# B5 — Worker asíncrono de procesamiento

## Alcance implementado

Worker en **Node.js 24 + TypeScript** empacado con la API (A4) y ejecutado por
`docuprocess-worker.service`. No crea infraestructura: consume el bucket de B2, las tablas de B3
y el tópico de B4.

- Consulta el GSI `status-createdAt` con `status = PENDING`, orden ascendente y un límite de
  `WORKER_BATCH_SIZE * 3` para reducir el bloqueo por documentos que aún no tienen archivo.
- Verifica `HeadObject`. Si el objeto no existe y el `PENDING` tiene menos de
  `UPLOAD_TIMEOUT_MINUTES`, lo salta; si ya venció, lo pasa a `FAILED` con `"upload timeout"`.
- Reclama con `UpdateItem` condicional (`#s = :pending`): dos workers nunca procesan el mismo
  documento. El segundo recibe `ConditionalCheckFailedException` y se retira.
- Descarga en streaming a un temporal con límite de bytes y calcula SHA-256 durante la lectura.
  El temporal se borra en `finally`.
- Detecta el MIME real con `file-type` (PDF/PNG/JPEG) y acepta UTF-8 válido como `text/plain`.
  Extrae páginas con `pdf-lib` y dimensiones con `image-size`; rechaza tipos no permitidos,
  archivos vacíos, PDFs corruptos e imágenes de más de 50 MP.
- Persiste `DONE` con `result` (o `FAILED` con `error`) y escribe el evento correspondiente en
  `document_events` con `actor="worker"`. `DONE` elimina un `error` anterior; `FAILED` elimina
  un `result` anterior.
- Publica el contrato de C1 en SNS con subject de máximo 100 caracteres. Si
  `SNS_TOPIC_ARN` está vacío, escribe el payload en el log.
- Bucle resistente a fallos por ítem, logs JSON a stdout y apagado limpio con `SIGTERM`/`SIGINT`
  (termina el ítem en curso y deja de reclamar).

## Configuración

Obligatorias: `DOCS_BUCKET`, `DDB_TABLE`, `DDB_EVENTS_TABLE`, `AWS_REGION`.

Opcionales: `SNS_TOPIC_ARN`, `DDB_ENDPOINT_URL`, `DDB_TRANSACTIONS` (`true`), `WORKER_POLL_SECONDS`
(`5`), `WORKER_BATCH_SIZE` (`10`), `UPLOAD_TIMEOUT_MINUTES` (`15`), `MAX_FILE_MB` (`10`) y
`LOG_LEVEL` (`INFO`).

## Pruebas

```bash
cd app/worker
npm ci
npm run typecheck
npm test
npm run build

# Integración: DynamoDB Local + bucket real. Crea 20 PENDING, levanta dos workers y verifica
# 20 DONE con un evento PROCESSING y uno DONE por documento.
RUN_INTEGRATION=1 DOCS_BUCKET=<bucket> npm run test:integration
```

La integración asume las tablas `documents` y `document_events` creadas (ver
`docs/architecture.md`, sección 13).

## Pendientes de integración

- **B3:** debe fusionarse para que existan `document_events` y la política que permite
  `TransactWriteItems`. Mientras tanto el worker puede ejecutarse con `DDB_TRANSACTIONS=false`
  contra DynamoDB Local.
- **B4:** el tópico SNS aún no está en `main`; `SNS_TOPIC_ARN` está vacío y el worker registra la
  notificación en el log. El criterio de “llega un correo por documento” se valida cuando B4
  cablee `module.sns.topic_arn`.
- **Recuperación de `PROCESSING`:** no es automática. Si una instancia muere después del claim,
  el ítem queda `PROCESSING`; el runbook manual consulta el GSI, verifica que no haya un worker
  vivo y vuelve a `PENDING` con un `Update` condicional, dejando el evento correspondiente.
