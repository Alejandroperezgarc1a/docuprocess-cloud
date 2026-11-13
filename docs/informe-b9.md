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

## Pruebas

```bash
bash -n scripts/deploy-frontend.sh
shellcheck scripts/deploy-frontend.sh

node frontend/scripts/generate-config.mjs
npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build

./scripts/deploy-frontend.sh
```

Prueba de credenciales vencidas:

```bash
env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_ACCESS_KEY_ID=expired AWS_SECRET_ACCESS_KEY=expired AWS_SESSION_TOKEN=expired \
  ./scripts/deploy-frontend.sh
```

Prueba E2E pendiente (cuando el estado y B7 estén alineados):

```bash
./scripts/deploy-frontend.sh
aws s3 ls "s3://<bucket>/"
aws s3api head-object --bucket "<bucket>" --key config.js --query CacheControl
aws s3api head-object --bucket "<bucket>" --key index.html --query CacheControl
curl -s "https://<dominio>/" | grep "<texto temporal>"
```

## Resultados de validación (2026-11-13)

- `bash -n scripts/deploy-frontend.sh`: OK.
- `shellcheck scripts/deploy-frontend.sh` (0.11.0): OK, sin advertencias.
- `node frontend/scripts/generate-config.mjs`: genera `frontend/public/config.js` con
  `apiBaseUrl: ""`.
- `npm ci`: 17 paquetes; `npm run build` (Vite 8.3.6): OK; `dist/index.html`, `dist/config.js`,
  `dist/assets/index-*.js` y `dist/assets/index-*.css`.
- `grep` sobre `dist/index.html`: carga `/config.js`; `dist/config.js` define
  `DOCUPROCESS_CONFIG` y `apiBaseUrl: ""`.
- `./scripts/deploy-frontend.sh` con las credenciales actuales: **falla antes de escribir** con
  `las credenciales son de la cuenta 556880009270, pero el estado de Terraform pertenece a
  491699813584`, que es el comportamiento seguro esperado.
- Credenciales inválidas: **falla en el primer paso** con `InvalidClientTokenId` y un mensaje que
  indica renovar la sesión de AWS Academy, antes de Terraform, npm o S3.

## Bloqueo actual y pendientes

El estado local de Terraform pertenece a la cuenta `491699813584`, pero las credenciales
disponibles son de `556880009270`. Además, el estado no contiene la distribución de CloudFront:
`cloudfront_distribution_id` y `cloudfront_domain_name` son `null` y solo aparecen el OAC y la
cache policy. Por eso no se puede demostrar todavía:

- la ejecución completa con URL final;
- el cambio visible en `index.html` tras la invalidación;
- el contenido real del bucket.

Para cerrarlo hay que usar credenciales de la cuenta dueña del estado (o recrear/importar el
estado en la cuenta actual) y aplicar B7. El script ya falla de forma segura mientras eso no esté
resuelto; no se debe aplicar el estado de 491 con credenciales de 556.

## Criterios de terminado

| Criterio | Estado |
| --- | --- |
| `./scripts/deploy-frontend.sh` termina sin errores e imprime la URL | Pendiente por C3/B7 |
| Un cambio en `index.html` aparece tras la invalidación | Pendiente por C3/B7 |
| El bucket no tiene `config.example.js` y sí `config.js` | Implementado y verificado por el script al ejecutarse |
| Credenciales vencidas fallan al inicio con mensaje claro | Verificado localmente |
