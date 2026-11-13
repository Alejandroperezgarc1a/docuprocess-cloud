#!/usr/bin/env bash
# Packages the application (A4) into dist/docuprocess-app.zip for Terraform to upload to S3.
#
#   ./scripts/package-app.sh          # from any folder
#
# For each component that exists (app/api, app/worker):
#   1. npm ci + npm run build in the repo (compiles TypeScript to dist/).
#   2. In a staging folder copies package.json, package-lock.json, dist/ and schema.sql
#      and installs ONLY production dependencies (npm ci --omit=dev). Instances then
#      need no internet or npm: node_modules travels inside the zip.
#
# The zip is deterministic (fixed dates, permissions and order): with the same code and
# the same toolchain (Node/npm/zip) the hash does not change, so Terraform does not replace instances.
#
# --ignore-scripts on production dependencies: today everything is plain JavaScript. If the
# worker (B5) adds native dependencies (sharp, canvas...), remove it and build for AL2023.
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
  # --include=dev: TypeScript is a devDependency and NODE_ENV=production would omit it.
  # rm -rf dist: a file deleted or renamed in src/ must not linger in the zip.
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

  # Out with what does not run in production.
  find "$dst" -type f -name '*.map' -delete
  find "$dst/node_modules" -type d -name .bin -prune -exec rm -rf {} +
  # Only type definitions (.d.ts): mysql2 declares @types/node as a production
  # dependency, but Node never loads them.
  rm -rf "$dst/node_modules/@types"
  rm -f "$dst/node_modules/.package-lock.json"
done

[[ $found -gt 0 ]] || die "no hay ningún componente en app/ (se esperaba app/api y/o app/worker)."

# Deterministic zip: same date and permissions on every file, fixed order and no extra attributes (-X).
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
find "$STAGE" -exec touch -h -d '2026-01-01T00:00:00Z' {} +
(cd "$STAGE" && find . -type f -print | LC_ALL=C sort | TZ=UTC zip -X -q -@ "$ZIP")
rm -rf "$STAGE"

echo "package-app: listo -> ${ZIP#"$ROOT"/} ($(du -h "$ZIP" | cut -f1), md5 $(md5sum "$ZIP" | cut -d' ' -f1))"
