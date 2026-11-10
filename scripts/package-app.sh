#!/usr/bin/env bash
# Empaqueta la aplicación (A4) en dist/docuprocess-app.zip para que Terraform lo suba a S3.
#
#   ./scripts/package-app.sh          # desde cualquier carpeta
#
# Por cada componente que exista (app/api, app/worker):
#   1. npm ci + npm run build en el repo (compila TypeScript a dist/).
#   2. En una carpeta de preparación copia package.json, package-lock.json, dist/ y schema.sql
#      e instala SOLO las dependencias de producción (npm ci --omit=dev). Así las instancias
#      no necesitan internet ni npm: el node_modules viaja dentro del zip.
#
# El zip es determinista (fechas fijas y orden estable): si el código no cambia, el hash no
# cambia y Terraform no dispara un instance refresh innecesario.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
ZIP="$OUT_DIR/docuprocess-app.zip"
STAGE="$OUT_DIR/stage"
COMPONENTS=(api worker)

die() { echo "package-app: ERROR: $*" >&2; exit 1; }

for cmd in node npm zip; do
  command -v "$cmd" >/dev/null 2>&1 || die "falta '$cmd' en el PATH (instalar Node.js 24 y zip)."
done

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

found=0
for comp in "${COMPONENTS[@]}"; do
  src="$ROOT/app/$comp"
  if [[ ! -f "$src/package.json" ]]; then
    echo "package-app: app/$comp no existe, se omite."
    continue
  fi
  [[ -f "$src/package-lock.json" ]] || die "app/$comp no tiene package-lock.json (npm ci lo necesita)."
  found=$((found + 1))

  echo "package-app: [$comp] npm ci + build"
  (cd "$src" && npm ci --no-audit --no-fund && npm run build)
  [[ -d "$src/dist" ]] || die "app/$comp: npm run build no generó dist/."

  dst="$STAGE/$comp"
  mkdir -p "$dst"
  cp "$src/package.json" "$src/package-lock.json" "$dst/"
  cp -R "$src/dist" "$dst/dist"
  if [[ -f "$src/schema.sql" ]]; then cp "$src/schema.sql" "$dst/"; fi

  echo "package-app: [$comp] dependencias de producción"
  (cd "$dst" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

  # Fuera lo que no se ejecuta en producción.
  find "$dst" -type f -name '*.map' -delete
  find "$dst/node_modules" -type d -name .bin -prune -exec rm -rf {} +
  rm -f "$dst/node_modules/.package-lock.json"
done

[[ $found -gt 0 ]] || die "no hay ningún componente en app/ (se esperaba app/api y/o app/worker)."

# Zip determinista: misma fecha en todos los archivos, orden fijo y sin atributos extra (-X).
find "$STAGE" -exec touch -h -d '2026-01-01T00:00:00Z' {} +
(cd "$STAGE" && find . -type f -print | LC_ALL=C sort | TZ=UTC zip -X -q -@ "$ZIP")
rm -rf "$STAGE"

echo "package-app: listo -> ${ZIP#"$ROOT"/} ($(du -h "$ZIP" | cut -f1), md5 $(md5sum "$ZIP" | cut -d' ' -f1))"
