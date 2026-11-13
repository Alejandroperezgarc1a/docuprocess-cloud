#!/usr/bin/env bash
# End-to-end test of the full flow against a deployment (C3/C4): registration and
# login of two users, document creation, direct upload to S3 with the presigned URL,
# worker processing (PDF and PNG -> DONE, fake PDF -> FAILED), event log and
# isolation between users.
# Creates test users and documents (unique emails per run); deletes nothing.
#
# Usage: ./scripts/e2e-test.sh [URL_BASE]
#   URL_BASE: e.g. https://dxxxx.cloudfront.net; defaults to the Terraform app_url output.
set -uo pipefail

for cmd in curl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "falta '$cmd'" >&2; exit 1; }
done

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra" && pwd)"
BASE="${1:-$(terraform -chdir="$INFRA_DIR" output -raw app_url 2>/dev/null)}"
BASE="${BASE%/}"
[ -n "$BASE" ] || { echo "indicar la URL base o correr terraform apply antes" >&2; exit 1; }

RUN="$(date +%s)"
USER_A="e2e-a-$RUN@docuprocess.test"
USER_B="e2e-b-$RUN@docuprocess.test"
PASSWORD="E2e-Clave-$RUN"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ok=0
mal=0

pass() { echo "  ✅ $1"; ok=$((ok + 1)); }
fail() { echo "  ❌ $1"; mal=$((mal + 1)); }
expect() { # description actual expected
  if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1: esperado '$3', obtenido '${2:-vacío}'"; fi
}
# Reads a field from the last JSON received: field 'token' | field 'items' len
field() {
  python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
v = d.get(sys.argv[2], "") if isinstance(d, dict) else ""
print(len(v) if len(sys.argv) > 3 else v)' "$WORK/out" "$@"
}
# call METHOD PATH [TOKEN] [JSON] -> prints the HTTP code; the body stays in $WORK/out
call() {
  local args=(-s -o "$WORK/out" -w '%{http_code}' -X "$1" "$BASE$2" -H 'Content-Type: application/json')
  [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-d "$4")
  curl "${args[@]}"
}

echo "== Salud ($BASE)"
expect "health profundo" "$(curl -s "$BASE/api/health?deep=1")" '{"status":"ok","checks":{"mysql":"ok","dynamodb":"ok"}}'

echo "== Usuarios (RDS)"
for user in "$USER_A" "$USER_B"; do
  expect "registro $user" "$(call POST /api/auth/register "" "{\"email\":\"$user\",\"password\":\"$PASSWORD\"}")" "201"
done
expect "login A" "$(call POST /api/auth/login "" "{\"email\":\"$USER_A\",\"password\":\"$PASSWORD\"}")" "200"
TOKEN_A="$(field token)"
expect "login B" "$(call POST /api/auth/login "" "{\"email\":\"$USER_B\",\"password\":\"$PASSWORD\"}")" "200"
TOKEN_B="$(field token)"
expect "contraseña incorrecta" "$(call POST /api/auth/login "" "{\"email\":\"$USER_A\",\"password\":\"mala-$RUN\"}")" "401"

# Real 1-page PDF, 3x2 PNG and a fake "PDF" (arbitrary bytes) that the worker must reject.
python3 - "$WORK" <<'EOF'
import struct, sys, zlib
w = sys.argv[1]
pdf = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
       b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n")
xref = len(pdf)
pdf += (b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n"
        b"0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % xref)
open(w + "/doc.pdf", "wb").write(pdf)
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
raw = b"\x00" + b"\xff\x00\x00" * 3 + b"\x00" + b"\x00\xff\x00" * 3
png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 3, 2, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
open(w + "/img.png", "wb").write(png)
open(w + "/fake.pdf", "wb").write(bytes(range(256)) * 4)
EOF

echo "== Subida (DynamoDB + URL prefirmada a S3)"
declare -A DOC_ID
for spec in doc.pdf:application/pdf img.png:image/png fake.pdf:application/pdf; do
  file="${spec%%:*}"
  type="${spec#*:}"
  size="$(wc -c < "$WORK/$file" | tr -d ' ')"
  expect "alta $file" "$(call POST /api/documents "$TOKEN_A" \
    "{\"filename\":\"$file\",\"contentType\":\"$type\",\"size\":$size}")" "201"
  DOC_ID[$file]="$(field documentId)"
  url="$(field uploadUrl)"
  expect "PUT a S3 de $file" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H "Content-Type: $type" --data-binary "@$WORK/$file" "$url")" "200"
done

echo "== Worker"
start=$SECONDS
while [ $((SECONDS - start)) -lt 120 ]; do
  pending=0
  for file in "${!DOC_ID[@]}"; do
    call GET "/api/documents/${DOC_ID[$file]}" "$TOKEN_A" >/dev/null
    case "$(field status)" in PENDING | PROCESSING) pending=1 ;; esac
  done
  [ "$pending" -eq 0 ] && break
  sleep 3
done
echo "  procesado en ~$((SECONDS - start)) s"
for spec in doc.pdf:DONE img.png:DONE fake.pdf:FAILED; do
  file="${spec%%:*}"
  call GET "/api/documents/${DOC_ID[$file]}" "$TOKEN_A" >/dev/null
  expect "estado de $file" "$(field status)" "${spec#*:}"
  call GET "/api/documents/${DOC_ID[$file]}/events" "$TOKEN_A" >/dev/null
  events="$(field items len)"
  if [ "${events:-0}" -ge 3 ]; then pass "bitácora de $file ($events eventos)"; else fail "bitácora de $file: $events eventos"; fi
done

echo "== Aislamiento y autenticación"
expect "B pide el documento de A" "$(call GET "/api/documents/${DOC_ID[doc.pdf]}" "$TOKEN_B")" "404"
expect "B pide la bitácora de A" "$(call GET "/api/documents/${DOC_ID[doc.pdf]}/events" "$TOKEN_B")" "404"
expect "listado sin token" "$(call GET /api/documents)" "401"
call GET /api/documents "$TOKEN_B" >/dev/null
expect "listado de B (vacío)" "$(field items len)" "0"

echo
echo "Resultado: $ok OK, $mal con problemas"
[ "$mal" -eq 0 ]
