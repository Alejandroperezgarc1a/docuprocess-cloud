# B5 — Worker asíncrono de procesamiento

## Alcance implementado

Worker en **Node.js 24 + TypeScript** empacado con la API (A4) y ejecutado por
`docuprocess-worker.service`. No crea infraestructura: consume el bucket de B2, las tablas de B3
y el tópico de B6.

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

# Integración: DynamoDB Local + bucket real (+ SNS opcional). Levanta dos workers y valida:
#   - 20 PENDING -> 20 DONE exactamente una vez (eventos PROCESSING y DONE)
#   - objeto ausente dentro del timeout: se salta y sigue PENDING
#   - objeto ausente vencido: FAILED "upload timeout" con evento FAILED
#   - con SNS_TOPIC_ARN: publica por cada DONE/FAILED; sin tópico: registra sns_skipped
RUN_INTEGRATION=1 DOCS_BUCKET=<bucket> [SNS_TOPIC_ARN=<topic>] npm run test:integration
```

La integración asume las tablas `documents` y `document_events` creadas (ver
`docs/architecture.md`, sección 13).

## Resultados de validación (2026-11-11)

Validado contra **DynamoDB Local + bucket real + tópico SNS temporal** en AWS Academy, y también
con `SNS_TOPIC_ARN` vacío para cubrir la rama `sns_skipped`:

- `npm run typecheck`, `npm test` (28/28) y `npm run build`: OK.
- `npm run test:integration`: **2/2** en verde.
  - Dos workers sobre 20 documentos: 20 `DONE`, sin dobles claims, eventos `PROCESSING` + `DONE`.
  - Objeto ausente reciente: se salta y permanece `PENDING` (`upload_pending`).
  - Objeto ausente vencido: `FAILED "upload timeout"` y evento `FAILED` con `actor="worker"`.
  - SNS: `sns_published` por cada `DONE`/`FAILED` con topic real; `sns_skipped` sin topic.
- `terraform fmt -check -recursive` y `terraform validate`: OK.
- Render del userData en sus dos variantes + ShellCheck: OK.
- `package-app.sh`: determinista (mismo md5 en dos corridas); el zip incluye
  `worker/dist/worker.js` y no trae fuentes, mapas ni dependencias de desarrollo.

### Revalidación (2026-11-11)

Se repitió la validación sobre el mismo commit `3786dc1` para confirmar que los resultados son
reproducibles:

- `npm run typecheck` y `npm test`: OK (28/28).
- Integración con SNS temporal: **2/2** (26.1 s); sin `SNS_TOPIC_ARN`: **2/2** (20.8 s).
- `terraform fmt`/`validate`, userData + ShellCheck y `package-app.sh`: OK; el zip conservó el
  md5 `21e883e83e1519b50cd203eb89b64351`.
- Los recursos temporales (bucket, tópico y DynamoDB Local) se eliminaron al terminar.

**Límites de la validación:** la entrega de correo no se pudo comprobar porque la suscripción a
`ingesoftv@gmail.com` seguía pendiente de confirmación (y el Sandbox deniega `sqs:CreateQueue`
para verificar SNS→SQS). Tampoco se probaron `document_events`/`TransactWriteItems` contra
DynamoDB de AWS ni el cableado de `module.sns.topic_arn`, porque B3 y B6 aún no están fusionados
en la rama de B5.

> **Actualización 2026-11-13:** la suscripción se confirmó y B10 verificó CloudWatch → SNS con la
> acción `Successfully executed action … docuprocess-dev-alerts` (ver `docs/informe-b10.md`).

## Pendientes de integración

- **B3:** debe fusionarse para que existan `document_events` y la política que permite
  `TransactWriteItems`. Mientras tanto el worker puede ejecutarse con `DDB_TRANSACTIONS=false`
  contra DynamoDB Local.
- **B6:** el tópico SNS aún no está en `main`; `SNS_TOPIC_ARN` está vacío y el worker registra la
  notificación en el log. El criterio de “llega un correo por documento” se valida cuando B6
  cablee `module.sns.topic_arn` y se confirme la suscripción de correo.
- **Recuperación de `PROCESSING`:** no es automática. Si una instancia muere después del claim,
  el ítem queda `PROCESSING`; el runbook manual consulta el GSI, verifica que no haya un worker
  vivo y vuelve a `PENDING` con un `Update` condicional, dejando el evento correspondiente.
