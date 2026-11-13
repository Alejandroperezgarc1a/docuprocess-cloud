#!/usr/bin/env bash
# Publica el frontend (build Vite) en su bucket S3 y refresca CloudFront (B9).
#
#   ./scripts/deploy-frontend.sh
#
# Requisitos:
#   - AWS CLI autenticado con la misma cuenta del estado de Terraform.
#   - Terraform inicializado y con B2 (bucket) y B7 (CloudFront) aplicados.
#   - Node.js >= 22.12 y npm.
#
# El script no crea infraestructura ni imprime credenciales. Lee los nombres
# desde los outputs raíz y falla antes de escribir si la cuenta no coincide.
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT/frontend"
INFRA_DIR="$ROOT/infra"
DIST_DIR="$FRONTEND_DIR/dist"
TMP_DIR="$(mktemp -d)"
AWS_PAGER=""
export AWS_PAGER

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log() { printf 'deploy-frontend: %s\n' "$*"; }
die() { printf 'deploy-frontend: ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "falta '$1' en el PATH."
}

# Lee un output raíz de Terraform y falla con un mensaje accionable.
tf_output() {
  local name="$1"
  local value
  local err="$TMP_DIR/tf-${name}.err"

  if ! value="$(terraform -chdir="$INFRA_DIR" output -no-color -raw "$name" 2>"$err")"; then
    local detail
    detail="$(tr '\n' ' ' < "$err")"
    die "no se pudo leer el output '$name'. Terraform no tiene estado, no está inicializado o el output no existe. Ejecuta 'terraform -chdir=infra init' y 'terraform -chdir=infra apply'. Detalle: $detail"
  fi

  if [[ -z "$value" || "$value" == "null" ]]; then
    die "el output '$name' está vacío o es null. Aplica la infraestructura que lo produce (B2/B7) antes de publicar."
  fi

  printf '%s' "$value"
}

# La región del Sandbox es us-east-1. Si el usuario cambia aws_region en
# terraform.tfvars, debe exportar AWS_REGION con el mismo valor.
if [[ -z "${AWS_REGION:-}" && -z "${AWS_DEFAULT_REGION:-}" ]]; then
  AWS_REGION="us-east-1"
  export AWS_REGION
  log "AWS_REGION no estaba definida; se usa us-east-1 (valor por defecto del proyecto)."
fi

require_cmd aws

log "Comprobando credenciales de AWS..."
if ! AWS_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>"$TMP_DIR/sts.err")"; then
  detail="$(tr '\n' ' ' < "$TMP_DIR/sts.err")"
  die "no se pudo autenticar con AWS. Las credenciales del Sandbox son temporales y vencen; renueva la sesión de AWS Academy y vuelve a ejecutar. Detalle: $detail"
fi
[[ -n "$AWS_ACCOUNT" ]] || die "aws sts get-caller-identity no devolvió una cuenta."
log "Cuenta AWS: $AWS_ACCOUNT"

for cmd in terraform node npm; do
  require_cmd "$cmd"
done

node_version="$(node -p 'process.versions.node')"
if ! printf '%s\n%s\n' "22.12.0" "$node_version" | sort -V -C; then
  die "Node $node_version es muy viejo: se necesita >= 22.12.0."
fi

[[ -f "$FRONTEND_DIR/package.json" ]] || die "no existe frontend/package.json."
[[ -f "$FRONTEND_DIR/package-lock.json" ]] || die "no existe frontend/package-lock.json (npm ci lo necesita)."
[[ -f "$FRONTEND_DIR/config.example.js" ]] || die "no existe frontend/config.example.js."
[[ -f "$FRONTEND_DIR/scripts/generate-config.mjs" ]] || die "no existe frontend/scripts/generate-config.mjs."

# Comprueba que el estado de Terraform pertenece a la cuenta autenticada.
STATE_ACCOUNT=""
if state_account_raw="$(terraform -chdir="$INFRA_DIR" output -no-color -raw account_id 2>/dev/null)"; then
  STATE_ACCOUNT="$state_account_raw"
else
  log "AVISO: no se pudo leer account_id; se omite la comprobación de cuenta."
fi

if [[ -n "$STATE_ACCOUNT" && "$STATE_ACCOUNT" != "null" && "$STATE_ACCOUNT" != "$AWS_ACCOUNT" ]]; then
  die "las credenciales son de la cuenta $AWS_ACCOUNT, pero el estado de Terraform pertenece a $STATE_ACCOUNT. No se publicó nada para no escribir en la cuenta equivocada. Alinea las credenciales con el estado o recrea/importa el estado (C3); nunca apliques un estado ajeno."
fi

log "Leyendo outputs de Terraform..."
BUCKET="$(tf_output frontend_bucket_name)"
DIST_ID="$(tf_output cloudfront_distribution_id)"
DOMAIN="$(tf_output cloudfront_domain_name)"

DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%/}"
[[ -n "$DOMAIN" ]] || die "el dominio de CloudFront está vacío."
URL="https://$DOMAIN/"

log "Bucket: s3://$BUCKET/"
log "Distribución CloudFront: $DIST_ID"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>"$TMP_DIR/s3.err"; then
  detail="$(tr '\n' ' ' < "$TMP_DIR/s3.err")"
  die "no se pudo acceder al bucket '$BUCKET'. Verifica que exista en la cuenta $AWS_ACCOUNT y que las credenciales tengan s3:ListBucket. Detalle: $detail"
fi

if ! CF_STATUS="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text 2>"$TMP_DIR/cf.err")"; then
  detail="$(tr '\n' ' ' < "$TMP_DIR/cf.err")"
  die "no se pudo consultar la distribución '$DIST_ID'. ¿B7 está aplicado y las credenciales tienen cloudfront:GetDistribution? Detalle: $detail"
fi
[[ "$CF_STATUS" == "Deployed" ]] || log "AVISO: la distribución está en estado '$CF_STATUS'; la invalidación puede tardar."

log "Instalando dependencias del frontend..."
if ! npm --prefix "$FRONTEND_DIR" ci --no-audit --no-fund; then
  die "npm ci falló en frontend/."
fi

log "Generando frontend/public/config.js..."
if ! npm --prefix "$FRONTEND_DIR" run config; then
  die "no se pudo generar frontend/public/config.js."
fi

# En producción manda config.js. Evita que un VITE_API_BASE_URL heredado del
# entorno apunte el build a otro origen.
unset VITE_API_BASE_URL VITE_API_PROXY_TARGET

log "Construyendo el frontend..."
if ! npm --prefix "$FRONTEND_DIR" run build; then
  die "npm run build falló en frontend/."
fi

[[ -f "$DIST_DIR/index.html" ]] || die "el build no generó frontend/dist/index.html."
[[ -f "$DIST_DIR/config.js" ]] || die "el build no generó frontend/dist/config.js."
[[ -d "$DIST_DIR/assets" ]] || die "el build no generó frontend/dist/assets/."
[[ -n "$(find "$DIST_DIR/assets" -type f -print -quit)" ]] || die "frontend/dist/assets/ está vacío."
grep -q 'DOCUPROCESS_CONFIG' "$DIST_DIR/config.js" || die "dist/config.js no define DOCUPROCESS_CONFIG."
grep -q 'apiBaseUrl: ""' "$DIST_DIR/config.js" || die "dist/config.js no fuerza apiBaseUrl vacío."
grep -q '/config.js' "$DIST_DIR/index.html" || die "dist/index.html no carga /config.js."
[[ ! -e "$DIST_DIR/config.example.js" ]] || die "el build copió config.example.js a dist/."

log "Sincronizando assets con s3://$BUCKET/ ..."
if ! aws s3 sync "$DIST_DIR/" "s3://$BUCKET/" \
  --delete \
  --exclude "index.html" \
  --exclude "config.js" \
  --exclude "config.example.js" \
  --cache-control "public,max-age=31536000,immutable" \
  --no-progress \
  --only-show-errors; then
  die "aws s3 sync falló al publicar los assets."
fi

log "Eliminando config.example.js del bucket si existe..."
if ! aws s3api delete-object --bucket "$BUCKET" --key "config.example.js" >/dev/null; then
  die "no se pudo eliminar config.example.js del bucket."
fi

log "Subiendo config.js e index.html con Cache-Control: no-cache ..."
if ! aws s3 cp "$DIST_DIR/config.js" "s3://$BUCKET/config.js" \
  --cache-control "no-cache" \
  --content-type "application/javascript; charset=utf-8" \
  --no-progress \
  --only-show-errors; then
  die "no se pudo subir config.js."
fi

if ! aws s3 cp "$DIST_DIR/index.html" "s3://$BUCKET/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8" \
  --no-progress \
  --only-show-errors; then
  die "no se pudo subir index.html."
fi

log "Verificando objetos y cabeceras en S3..."
if ! aws s3api head-object --bucket "$BUCKET" --key "config.js" >/dev/null 2>&1; then
  die "config.js no está presente en el bucket después de la subida."
fi
if aws s3api head-object --bucket "$BUCKET" --key "config.example.js" >/dev/null 2>&1; then
  die "config.example.js sigue presente en el bucket; no se publicó correctamente."
fi

CACHE_INDEX="$(aws s3api head-object --bucket "$BUCKET" --key "index.html" --query CacheControl --output text)"
CACHE_CONFIG="$(aws s3api head-object --bucket "$BUCKET" --key "config.js" --query CacheControl --output text)"
[[ "$CACHE_INDEX" == "no-cache" ]] || die "index.html tiene Cache-Control '$CACHE_INDEX'; se esperaba 'no-cache'."
[[ "$CACHE_CONFIG" == "no-cache" ]] || die "config.js tiene Cache-Control '$CACHE_CONFIG'; se esperaba 'no-cache'."

ASSET_KEY="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "assets/" --query 'Contents[0].Key' --output text)"
[[ -n "$ASSET_KEY" && "$ASSET_KEY" != "None" ]] || die "no se encontraron assets en el bucket."
CACHE_ASSET="$(aws s3api head-object --bucket "$BUCKET" --key "$ASSET_KEY" --query CacheControl --output text)"
[[ "$CACHE_ASSET" == *"max-age=31536000"* ]] || die "el asset '$ASSET_KEY' no tiene caché larga (Cache-Control: '$CACHE_ASSET')."

log "Creando invalidación de CloudFront ..."
if ! INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query 'Invalidation.Id' --output text 2>"$TMP_DIR/invalidation.err")"; then
  detail="$(tr '\n' ' ' < "$TMP_DIR/invalidation.err")"
  die "no se pudo crear la invalidación. Verifica cloudfront:CreateInvalidation y el estado de la distribución. Detalle: $detail"
fi
[[ -n "$INVALIDATION_ID" && "$INVALIDATION_ID" != "None" ]] || die "CloudFront no devolvió un ID de invalidación."

log "Invalidación $INVALIDATION_ID creada; esperando a que complete ..."
if aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$INVALIDATION_ID"; then
  log "Invalidación completada."
else
  log "AVISO: la invalidación aún no ha terminado; CloudFront la completará en unos minutos."
fi

log ""
log "Frontend publicado correctamente."
log "  Bucket: s3://$BUCKET/"
log "  Distribución: $DIST_ID"
log "  Invalidación: $INVALIDATION_ID"
printf '%s\n' "$URL"
