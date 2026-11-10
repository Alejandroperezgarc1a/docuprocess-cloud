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
# El zip es determinista (fechas, permisos y orden fijos): con el mismo código y la misma
# cadena de herramientas (Node/npm/zip), el hash no cambia y Terraform no reemplaza las instancias.
#
# --ignore-scripts en las dependencias de producción: hoy todo es JavaScript puro. Si el worker (B5)
# agrega dependencias nativas (sharp, canvas...), hay que quitarlo y compilar para AL2023.
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
ZIP="$OUT_DIR/docuprocess-app.zip"
STAGE="$OUT_DIR/stage"
COMPONENTS=(api worker)

die() { echo "package-app: ERROR: $*" >&2; exit 1; }

for cmd in node npm zip; do
  command -v "$cmd" >/dev/null 2>&1 || die "falta '$cmd' en el PATH (instalar Node.js 24 y zip)."
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ $node_major -ge 22 ]] || die "Node $(node --version) es muy viejo: se necesita >= 22 (las instancias usan 24)."

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
  # --include=dev: TypeScript es devDependency y NODE_ENV=production lo omitiría.
  # rm -rf dist: que un archivo borrado o renombrado en src/ no quede viejo en el zip.
  rm -rf "$src/dist"
  (cd "$src" && npm ci --include=dev --no-audit --no-fund && npm run build)
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

# Zip determinista: misma fecha y permisos en todos los archivos, orden fijo y sin atributos extra (-X).
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
find "$STAGE" -exec touch -h -d '2026-01-01T00:00:00Z' {} +
(cd "$STAGE" && find . -type f -print | LC_ALL=C sort | TZ=UTC zip -X -q -@ "$ZIP")
rm -rf "$STAGE"

echo "package-app: listo -> ${ZIP#"$ROOT"/} ($(du -h "$ZIP" | cut -f1), md5 $(md5sum "$ZIP" | cut -d' ' -f1))"
