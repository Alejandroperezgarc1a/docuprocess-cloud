# B9 — Publicación del frontend en S3 y CloudFront

## Alcance implementado

Script `scripts/deploy-frontend.sh` para publicar el frontend con un solo comando, usando los
outputs de Terraform y sin hardcodear bucket, cuenta ni distribución. No crea infraestructura:

1. Comprueba las credenciales de AWS antes de cualquier otra operación.
2. Compara la cuenta autenticada con `account_id` del estado de Terraform.
3. Lee `frontend_bucket_name`, `cloudfront_distribution_id` y `cloudfront_domain_name`.
4. Genera `frontend/public/config.js` desde `frontend/config.example.js` con `apiBaseUrl: ""`.
5. Ejecuta `npm ci` y `npm run build` en `frontend/` y valida `dist/`.
6. Sincroniza `frontend/dist/` al bucket con `--delete`.
7. Aplica caché larga a los assets con hash y `no-cache` a `index.html` y `config.js`.
8. Elimina `config.example.js` del bucket si quedó de una publicación anterior.
9. Crea una invalidación `/*` y espera a que CloudFront la complete.
10. Imprime la URL pública como última línea.

## Adaptaciones respecto a la HU

La HU asumía un frontend estático sin build y un `config.example.js` que ya no existían: la
migración a Vite (commit `c551a71`) eliminó la configuración de runtime. Para que los criterios
sean reales y no código muerto:

- Se publica `frontend/dist/`, no `frontend/`. El código fuente usa `import.meta.env` y no es
  ejecutable directamente en el navegador; además incluiría `package.json` y `node_modules`.
- Se restauró `frontend/config.example.js` y se genera `frontend/public/config.js`, que Vite
  copia a `dist/config.js`. Así el archivo servido es el mismo que espera la HU, sin romper Vite.
- `frontend/index.html` carga `config.js` antes del módulo y deja un fallback vacío para que el
  desarrollo sin `config.js` no falle.
- `frontend/app.js` usa `import.meta.env.VITE_API_BASE_URL ?? CONFIG.apiBaseUrl ?? ""`. El `??`
  es deliberado: `apiBaseUrl: ""` es un valor válido (mismo origen) y no debe caer al fallback.
- El script hace `unset VITE_API_BASE_URL VITE_API_PROXY_TARGET` antes del build para que una
  variable heredada del entorno no apunte el frontend a otro origen.
- `--exclude config.example.js` no borra un objeto existente (también lo excluye de `--delete`);
  por eso el script ejecuta un `delete-object` explícito e idempotente.
- La invalidación es asíncrona: se espera con `aws cloudfront wait invalidation-completed`. Si el
  waiter expira, se avisa pero no se falla; la invalidación sigue en curso.

## Configuración

- `frontend/config.example.js`: plantilla versionada con `window.DOCUPROCESS_CONFIG`.
- `frontend/public/config.js`: generado y **no versionado** (`.gitignore`).
- `frontend/scripts/generate-config.mjs`: fuerza `apiBaseUrl: ""` y valida el resultado.
- `frontend/package.json`: `config`, `predev` y `prebuild` generan el archivo automáticamente.
- El script usa `AWS_REGION`/`AWS_DEFAULT_REGION`; si no están definidas, cae a `us-east-1`, el
  valor por defecto del proyecto. Si se cambia `aws_region`, hay que exportar la misma región.
- El script no elige perfil de AWS: hereda `AWS_PROFILE`. En este repositorio se validó con
  `AWS_PROFILE=academy` (cuenta `<AWS_ACCOUNT_ID>`, us-east-1).

## Pruebas

```bash
bash -n scripts/deploy-frontend.sh
shellcheck scripts/deploy-frontend.sh

node frontend/scripts/generate-config.mjs
npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build

export AWS_PROFILE=academy
./scripts/deploy-frontend.sh
```

Prueba de credenciales vencidas:

```bash
env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_ACCESS_KEY_ID=expired AWS_SECRET_ACCESS_KEY=expired AWS_SESSION_TOKEN=expired \
  ./scripts/deploy-frontend.sh
```

Verificación posterior:

```bash
BUCKET="$(terraform -chdir=infra output -raw frontend_bucket_name)"
DIST_ID="$(terraform -chdir=infra output -raw cloudfront_distribution_id)"
DOMAIN="$(terraform -chdir=infra output -raw cloudfront_domain_name)"

aws s3 ls "s3://$BUCKET/"
aws s3api head-object --bucket "$BUCKET" --key config.js --query CacheControl
aws s3api head-object --bucket "$BUCKET" --key index.html --query CacheControl
aws cloudfront get-invalidation --distribution-id "$DIST_ID" --id "<id>" --query 'Invalidation.Status'
curl -sS "https://$DOMAIN/" | grep "<texto temporal>"
```

## Resultados de validación (2026-11-13)

### Infraestructura

El laboratorio de AWS Academy se reinició y la cuenta `<AWS_ACCOUNT_ID>` quedó sin los recursos del
proyecto. Para validar B9 se refrescó el estado y se reaplicó el stack:

- `terraform plan -refresh=true`: **64 to add, 0 change, 3 destroy** (los 3 destroy eran recursos
  que ya no existían y el refresh retiró del estado).
- `terraform apply`: **64 added, 0 changed, 3 destroyed**.
- Outputs usados por B9: bucket `docuprocess-dev-frontend-<BUCKET_SUFFIX>`, distribución
  `<CLOUDFRONT_DISTRIBUTION_ID>`, dominio `<CLOUDFRONT_DOMAIN>`.

### Publicación

- `./scripts/deploy-frontend.sh` terminó con exit 0 e imprimió como última línea
  `https://<CLOUDFRONT_DOMAIN>/`.
- Invalidación inicial `<INVALIDATION_ID>`: `Completed`.
- Estado de la distribución: `Deployed`.
- `config.js`: presente, 300 bytes, `Cache-Control: no-cache`, content type
  `application/javascript; charset=utf-8`.
- `index.html`: presente, 8676 bytes, `Cache-Control: no-cache`, content type
  `text/html; charset=utf-8`.
- `assets/index-C8LabvmO.js`: `Cache-Control: public,max-age=31536000,immutable`.
- `config.example.js`: ausente; `head-object` falla como se espera.
- `https://<CLOUDFRONT_DOMAIN>/` responde 200, `/config.js` responde 200 y
  `/api/health` responde 200 sobre la infraestructura recreada.

### Cambio visible en index.html

Se editó `frontend/index.html` para añadir el marcador `B9-CHECK-SOURCE-2026-11-13T15:05Z`, se
ejecutó el script y se comprobó el resultado:

- Invalidación `<INVALIDATION_ID_2>`: `Completed`.
- `curl -sS https://<CLOUDFRONT_DOMAIN>/` devolvió el marcador.
- Se revirtió el cambio con `git checkout -- frontend/index.html` y se volvió a ejecutar el
  script para restaurar el build original.
- Invalidación de restauración `<INVALIDATION_ID_RESTORE>`: `Completed`; el marcador ya no
  aparece y el árbol de trabajo quedó limpio.

También se hizo una prueba intermedia publicando un `index.html` temporal directamente en S3
(marcador `B9-CHECK-2026-11-13T14:45Z`, invalidación `I1RJ88Y4JTR8BUKG2WDYRV0GK0`, `Completed`).
La prueba desde el código fuente es la evidencia principal porque cubre el flujo completo
build → S3 → invalidación → CloudFront.

### Seguridad y credenciales

- Con el perfil `default` (cuenta `<OTHER_AWS_ACCOUNT_ID>`) y el estado de `<AWS_ACCOUNT_ID>`, el script falla
  **antes de escribir** con un mensaje de cuenta incorrecta. No se aplicó nada sobre el estado
  ajeno.
- Con credenciales inválidas (`InvalidClientTokenId`), falla en `aws sts get-caller-identity`,
  antes de Terraform, npm o S3.
- No se usan ACL públicas: el bucket es privado y CloudFront accede por OAC.

### Calidad

- `bash -n scripts/deploy-frontend.sh`: OK.
- `shellcheck scripts/*.sh`: OK, sin advertencias.
- `terraform -chdir=infra fmt -check -recursive`: OK.
- `npm ci` y `npm run build` (Vite 8.3.6): OK.
- CI del PR #52: Frontend Vite build, ShellCheck y Terraform fmt+validate en verde.

## Estado final

B9 queda cerrado y demostrado en AWS. No hay bloqueos pendientes para la publicación del
frontend. La guía de despliegue ampliada y el resto del troubleshooting corresponden a A9/C4.

## Criterios de terminado

| Criterio | Evidencia | Estado |
| --- | --- | --- |
| `./scripts/deploy-frontend.sh` termina sin errores e imprime la URL | Exit 0; última línea `https://<CLOUDFRONT_DOMAIN>/` | Verificado |
| Un cambio en `index.html` aparece tras la invalidación | Marcador de origen + invalidación `<INVALIDATION_ID_2>`; `curl` devuelve el marcador | Verificado |
| El bucket no tiene `config.example.js` y sí `config.js` | `head-object` de `config.js` OK; `config.example.js` ausente | Verificado |
| Credenciales vencidas fallan al inicio con mensaje claro | `InvalidClientTokenId` antes de Terraform/npm/S3 | Verificado |
