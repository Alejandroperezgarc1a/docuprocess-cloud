# API de DocuProcess Cloud (A6)

API REST en Flask con autenticación MySQL/bcrypt/JWT y documentos en
DynamoDB + S3 mediante URLs prefirmadas. Toda la configuración se lee de
variables de entorno; no hay secretos en el código.

## Requisitos

- Python 3.9 (Amazon Linux 2023).
- MySQL 8.0 y DynamoDB Local de `docker-compose.yml` para desarrollo.
- Credenciales del Sandbox de AWS para probar la URL prefirmada contra S3.

## Instalación local

```bash
cd app/api
python3.9 -m venv .venv
. .venv/bin/activate

# Producción
pip install -r requirements.txt

# Desarrollo y pruebas
pip install -r requirements-dev.txt
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
# Para probar solo autenticación puede usarse un nombre ficticio; el PUT a S3
# fallará hasta usar un bucket real del Sandbox.
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
```

Obligatorias: `DOCS_BUCKET`, `DDB_TABLE`, `DB_HOST`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, `JWT_SECRET`, `AWS_REGION`.
Opcionales: `DB_PORT` (3306), `DDB_ENDPOINT_URL`, `CORS_ALLOWED_ORIGINS`.

La API falla al arrancar si falta una obligatoria o si `DOCS_BUCKET` está
vacío. El esquema de MySQL se intenta aplicar al arrancar, pero un MySQL
apagado no impide arrancar: `/api/health` debe seguir respondiendo 200 y el
esquema se reintenta en el primer registro/login.

## DynamoDB Local

La API consume la tabla `documents` (no la crea). Crear la tabla con el
comando de `docs/architecture.md`, sección 13:

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
```

## Ejecutar

Desde `app/api`, con el entorno cargado:

```bash
gunicorn --workers 2 --bind 0.0.0.0:8000 \
  --access-logfile - --error-logfile - app:app
```

Comando para el unit `docuprocess-api.service` de A4:

```ini
WorkingDirectory=/opt/docuprocess/api
EnvironmentFile=/etc/docuprocess.env
ExecStart=/opt/docuprocess/venv/bin/gunicorn \
  --workers 2 --bind 0.0.0.0:8000 \
  --access-logfile - --error-logfile - \
  --timeout 30 --graceful-timeout 30 app:app
```

Los logs salen por stdout/stderr y systemd los recoge en journald.

## Pruebas

```bash
cd app/api
pytest tests -q
```

Las pruebas son herméticas: `moto` simula DynamoDB/S3 y SQLite simula MySQL.
Para ejecutar la misma suite contra el MySQL de docker-compose:

```bash
docker compose up -d mysql
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=docuprocess \
DB_USER=docuadmin DB_PASSWORD="$DB_PASSWORD" \
TEST_MYSQL=1 pytest tests -q
```

## Verificación manual

```bash
curl -i localhost:8000/api/health          # 200 {"status":"ok"}
curl -i 'localhost:8000/api/health?deep=1' # 200 con MySQL y DynamoDB arriba

# health independiente de MySQL
docker compose stop mysql
curl -i localhost:8000/api/health          # sigue siendo 200
docker compose start mysql
```

Flujo completo:

```bash
BASE=http://localhost:8000
curl -s -X POST $BASE/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}'

TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

curl -s -X POST $BASE/api/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"demo.pdf","contentType":"application/pdf","size":12345}'

# Copiar uploadUrl y documentId de la respuesta anterior:
curl -X PUT "$UPLOAD_URL" \
  -H 'Content-Type: application/pdf' \
  --data-binary @demo.pdf

curl -s $BASE/api/documents/$DOCUMENT_ID \
  -H "Authorization: Bearer $TOKEN"
```

La URL prefirmada dura 900 s. La API no puede imponer el tamaño en un PUT
prefirmado; el worker (B6) valida el archivo real. Para ver `PENDING`, no
levantes el worker durante la prueba. El PUT directo a S3 requiere los
permisos de B1/B2 sobre `uploads/*` y CORS del bucket si se prueba desde el
navegador.
