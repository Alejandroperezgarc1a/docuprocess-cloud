# API de DocuProcess Cloud (B4)

API REST en **Node.js 24 + TypeScript** (Express 5) con autenticación MySQL/bcrypt/JWT y
gestión de documentos en DynamoDB + S3 mediante URLs prefirmadas. Toda la configuración
se lee de variables de entorno; no hay secretos en el código.

## Requisitos

- Node.js 24 (Amazon Linux 2023: paquetes `nodejs24` y `nodejs24-npm`).
- MySQL 8.0 y DynamoDB Local de `docker-compose.yml` para desarrollo.
- Credenciales del Sandbox de AWS para probar la URL prefirmada contra S3.

## Instalación local

```bash
cd app/api
npm ci
npm run build
```

## Variables de entorno

Se leen del entorno, no de archivos. Para desarrollo:

```bash
cp ../../.env.example ../../.env
# completar DB_PASSWORD, MYSQL_ROOT_PASSWORD y JWT_SECRET
set -a
. ../../.env
set +a

# DOCS_BUCKET es obligatorio y no puede estar vacío.
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
```

Obligatorias: `DOCS_BUCKET`, `DDB_TABLE`, `DDB_EVENTS_TABLE`, `DB_HOST`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, `AWS_REGION`.
Opcionales: `DB_PORT` (3306), `DDB_TRANSACTIONS` (`true`), `DDB_ENDPOINT_URL`,
`CORS_ALLOWED_ORIGINS`.

La API falla al arrancar si falta una obligatoria o si `JWT_SECRET` tiene menos de
32 caracteres. El esquema de MySQL se intenta aplicar al arrancar, pero un MySQL
apagado no impide arrancar: `/api/health` sigue respondiendo 200 y el esquema se
reintenta en el primer registro/login.

## DynamoDB Local

La API consume dos tablas (no las crea): `documents` (estado y cola) y
`document_events` (bitácora append-only). Crear ambas con los comandos de
`docs/architecture.md`, sección 13:

```bash
docker compose up -d
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table --endpoint-url http://localhost:8001 --region us-east-1 \
  --table-name documents --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=documentId,AttributeType=S AttributeName=userId,AttributeType=S \
      AttributeName=status,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=documentId,KeyType=HASH \
  --global-secondary-indexes \
    '[{"IndexName":"userId-createdAt","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"status-createdAt","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'

# Bitacora de cambios de estado (append-only)
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table --endpoint-url http://localhost:8001 --region us-east-1 \
  --table-name document_events --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=documentId,AttributeType=S AttributeName=eventAt,AttributeType=S \
      AttributeName=userId,AttributeType=S AttributeName=eventDay,AttributeType=S \
  --key-schema AttributeName=documentId,KeyType=HASH AttributeName=eventAt,KeyType=RANGE \
  --global-secondary-indexes \
    '[{"IndexName":"userId-eventAt","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"},{"AttributeName":"eventAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"day-eventAt","KeySchema":[{"AttributeName":"eventDay","KeyType":"HASH"},{"AttributeName":"eventAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'
```

## Ejecutar

Desarrollo (recarga automática):

```bash
npm run dev
```

Producción:

```bash
npm run build
WEB_CONCURRENCY=2 node dist/server.js
```

Comando para el unit `docuprocess-api.service` de A4:

```ini
WorkingDirectory=/opt/docuprocess/api
EnvironmentFile=/etc/docuprocess.env
ExecStart=/usr/bin/node /opt/docuprocess/api/dist/server.js
Environment=WEB_CONCURRENCY=2
Restart=always
User=docuprocess
```

Los logs salen por stdout/stderr y systemd los recoge en journald.

## Documentación de la API

- Swagger UI: `http://localhost:8000/api/docs`
- OpenAPI 3.0: `http://localhost:8000/api/openapi.json`

## Pruebas

```bash
cd app/api
npm run typecheck
npm test
```

Las pruebas son herméticas: usan dobles en memoria para MySQL y AWS, sin necesidad
de docker-compose ni credenciales.

## Verificación manual

```bash
curl -i localhost:8000/api/health          # 200 {"status":"ok"}
curl -i 'localhost:8000/api/health?deep=1' # 200 con MySQL y DynamoDB arriba

# health independiente de MySQL
docker compose stop mysql
curl -i localhost:8000/api/health          # sigue en 200
docker compose start mysql

# flujo register -> login -> documento
curl -s -X POST localhost:8000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}'

TOKEN=$(curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

curl -s -X POST localhost:8000/api/documents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"filename":"demo.pdf","contentType":"application/pdf","size":12345}'

# bitacora del documento (sustituir DOCUMENT_ID)
curl -s localhost:8000/api/documents/DOCUMENT_ID/events \
  -H "Authorization: Bearer $TOKEN"
```

## Empaquetado para A4

El artefacto debe incluir `dist/`, `node_modules` de producción, `schema.sql` y
`package.json`. El build se hace con dependencias de desarrollo y luego se puede
podar con `npm prune --omit=dev` antes de comprimir.
