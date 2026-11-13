#!/usr/bin/env bash
# Verifies the configuration and privacy of the storage module buckets (B2).
# Usage: scripts/test-storage.sh [docs] [frontend] [artifacts]
# With no arguments it reads the Terraform outputs from infra/.
set -euo pipefail

# AWS_PROFILE is not fixed: it uses the caller's one or the default
# AWS credential chain.
region="${AWS_REGION:-us-east-1}"
failures=0

fail() { echo "FALLA: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

check_eq() { # description, expected, actual
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (esperado '$2', obtenido '$3')"
  fi
}

if [ "$#" -eq 3 ]; then
  docs="$1"
  frontend="$2"
  artifacts="$3"
else
  infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra" && pwd)"
  docs="$(terraform -chdir="$infra_dir" output -raw docs_bucket_name)"
  frontend="$(terraform -chdir="$infra_dir" output -raw frontend_bucket_name)"
  artifacts="$(terraform -chdir="$infra_dir" output -raw artifacts_bucket_name)"
fi

for bucket in "$docs" "$frontend" "$artifacts"; do
  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    pass "existe $bucket"
  else
    fail "no existe o no es accesible $bucket"
    continue
  fi

  pab="$(aws s3api get-public-access-block --bucket "$bucket" \
    --query 'PublicAccessBlockConfiguration' --output json)"
  for key in BlockPublicAcls BlockPublicPolicy IgnorePublicAcls RestrictPublicBuckets; do
    check_eq "$bucket $key" "true" "$(printf '%s' "$pab" | jq -r ".$key")"
  done

  check_eq "$bucket ownership" "BucketOwnerEnforced" \
    "$(aws s3api get-bucket-ownership-controls --bucket "$bucket" \
      --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)"

  check_eq "$bucket cifrado" "AES256" \
    "$(aws s3api get-bucket-encryption --bucket "$bucket" \
      --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
      --output text)"

  tags="$(aws s3api get-bucket-tagging --bucket "$bucket" --query 'TagSet' --output json)"
  for tag in Project Environment ManagedBy Name; do
    if printf '%s' "$tags" | jq -e --arg t "$tag" 'any(.[]; .Key == $t)' >/dev/null; then
      pass "$bucket tag $tag"
    else
      fail "$bucket sin tag $tag"
    fi
  done
done

# CORS: documents bucket only.
cors="$(aws s3api get-bucket-cors --bucket "$docs" --query 'CORSRules[0]' --output json)"
for method in PUT GET HEAD; do
  if printf '%s' "$cors" | jq -e --arg m "$method" '.AllowedMethods | index($m)' >/dev/null; then
    pass "CORS permite $method"
  else
    fail "CORS no permite $method"
  fi
done
check_eq "CORS Content-Type" "Content-Type" \
  "$(printf '%s' "$cors" | jq -r '.AllowedHeaders[0]')"
check_eq "CORS ETag" "ETag" \
  "$(printf '%s' "$cors" | jq -r '.ExposeHeaders[0]')"

# Versioning on artifacts only.
check_eq "artifacts versionado" "Enabled" \
  "$(aws s3api get-bucket-versioning --bucket "$artifacts" --query 'Status' --output text)"

# Resource-based policies.
docs_policy="$(aws s3api get-bucket-policy --bucket "$docs" --query Policy --output text)"
if printf '%s' "$docs_policy" | jq -e '.Statement[0].Action | index("s3:PutObject")' >/dev/null; then
  pass "política docs permite PutObject"
else
  fail "política docs sin PutObject"
fi
if printf '%s' "$docs_policy" | jq -e '.Statement[0].Resource | tostring | endswith("/uploads/*")' >/dev/null; then
  pass "política docs limitada a uploads/*"
else
  fail "política docs con recurso inesperado"
fi

artifacts_policy="$(aws s3api get-bucket-policy --bucket "$artifacts" --query Policy --output text)"
if printf '%s' "$artifacts_policy" | jq -e '.Statement[0].Action | index("s3:GetObject")' >/dev/null; then
  pass "política artifacts permite GetObject"
else
  fail "política artifacts sin GetObject"
fi

# Privacy: the anonymous URL must fail and the presigned one must work.
tmp="$(mktemp)"
printf 'prueba-storage' > "$tmp"
key="uploads/test-storage/$(date +%s).txt"
cleanup() {
  aws s3api delete-object --bucket "$docs" --key "$key" >/dev/null 2>&1 || true
  rm -f "$tmp"
}
trap cleanup EXIT

if aws s3api put-object --bucket "$docs" --key "$key" --body "$tmp" >/dev/null 2>&1; then
  pass "objeto de prueba subido"
  code="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' \
    "https://${docs}.s3.${region}.amazonaws.com/${key}" || true)"
  check_eq "URL pública anónima" "403" "$code"

  url="$(aws s3 presign "s3://${docs}/${key}" --expires-in 120 --region "$region")"
  code="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' "$url" || true)"
  check_eq "URL prefirmada GET" "200" "$code"
else
  fail "no se pudo subir el objeto de prueba"
fi

if aws s3api get-bucket-lifecycle-configuration --bucket "$docs" >/dev/null 2>&1; then
  echo "info: el bucket docs tiene regla de ciclo de vida"
else
  echo "info: el bucket docs no tiene regla de ciclo de vida"
fi

if [ "$failures" -gt 0 ]; then
  echo "test-storage: $failures comprobación(es) fallaron" >&2
  exit 1
fi

echo "test-storage: todo correcto"
