# Guía de despliegue y solución de problemas (AWS Academy Sandbox)

Esta guía cubre el despliegue completo de DocuProcess Cloud desde una cuenta vacía del Sandbox de AWS Academy (Learner Lab), la verificación final y la destrucción del entorno, más la solución a los tropiezos conocidos del Sandbox. Tiempo estimado: 30–45 minutos para el primer despliegue completo. La versión ampliada, con preflight, importación de huérfanos y verificación por capas, está en [`despliegue-automatizado-sandbox.md`](despliegue-automatizado-sandbox.md) y su [PDF](despliegue-automatizado-sandbox.pdf).

## 0. Requisitos

- **Cuenta**: AWS Academy → Learner Lab, región **us-east-1**, plan de **creación de recursos permitida** por el Sandbox (sin IAM propio, sin Lambda, instancias pequeñas, EBS `gp2`).
- **Rol obligatorio** (no se puede crear): `AmazonSSMRoleForInstancesQuickSetup` — la consola del lab lo trae. Verificar (paso 1.4).
- **Herramientas locales**: `aws` CLI v2, `terraform` ≥ 1.9 (`infra/.terraform.lock.hcl`), `node` ≥ 22 (el CI y el userData usan AL2023 + `nodejs24`), `npm`, `ab` (apache2-utils/httpd-tools), `jq`, `curl`, `zip`, `python3`, `bash` ≥ 5, `shellcheck` (opcional).
- **Credenciales vigentes** de la sesión del laboratorio (expiran con la sesión; ver §1).

## 1. Credenciales del Sandbox (paso a paso)

1. Entra al curso → **Learner Lab** → **Start Lab** y espera a que el indicador esté en verde.
2. **AWS Details** → **AWS CLI** → **Show** → copia `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token`.
   - Nunca pegues estas credenciales en el chat, en commits ni en el repo.
3. Edita `~/.aws/credentials` (o `~/.aws/config`) y guarda el perfil. Ejemplo `[default]`:

   ```ini
   [default]
   aws_access_key_id = TU_ACCESS_KEY
   aws_secret_access_key = TU_SECRET_KEY
   aws_session_token = TU_SESSION_TOKEN
   ```

   o un perfil `[profile academy]` con `export AWS_PROFILE=academy` para comandos y scripts.
   En `~/.aws/config` fija `region = us-east-1`, `output = json`.

4. Verifica la cuenta y el rol:

   ```bash
   aws sts get-caller-identity          # debe ser la cuenta del laboratorio
   aws iam list-instance-profiles --query 'InstanceProfiles[].InstanceProfileName' --output json
   ```

   En la lista debe verse `AmazonSSMRoleForInstancesQuickSetup` (o el nombre equivalente indicado por el instructor). **No** crees roles: el Sandbox es de solo lectura para IAM. Si falta, el instructor define el nombre exacto; ajustar `instance_role_name` en `infra/variables.tf`.

5. Las credenciales expiran cuando la sesión del lab muere. Síntoma: `InvalidClientTokenId` / `ExpiredToken`. Solución: nueva sesión → re-copiar → re-exportar `AWS_PROFILE`; el flujo Terraform es idempotente (`terraform plan -refresh=true` y aplicar de nuevo).

## 2. Despliegue

```bash
git clone git@github.com:Alejandroperezgarc1a/docuprocess-cloud.git
cd docuprocess-cloud

cp infra/terraform.tfvars.example infra/terraform.tfvars
# editar terraform.tfvars: alert_email (buzón real), db_password, jwt_secret
#   openssl rand -hex 16   # db_password
#   openssl rand -hex 32   # jwt_secret

./scripts/package-app.sh           # Node ci + build → dist/docuprocess-app.zip (determinista)
terraform -chdir=infra init
terraform -chdir=infra apply       # ~73 recursos; la primera vez crea red, S3, RDS, DDB, SNS, EC2/ASG, CF, CloudWatch
```

Notas del `apply`:

- El artefacto de la app lo sube Terraform (`aws_s3_object`): **siempre** `package-app.sh` antes del `apply`. Si no existe `dist/docuprocess-app.zip`, la precondición falla con "ejecutar ./scripts/package-app.sh antes de terraform apply".
- Los secretos van a SSM (`/docuprocess-dev/db_password`, `/docuprocess-dev/jwt_secret`, SecureString). Si el parámetro **ya existe** fuera del estado (despliegue previo en la misma cuenta), el `apply` falla con `ParameterAlreadyExists` → borrarlo (`aws ssm delete-parameter --name /docuprocess-dev/db_password`) o importarlo al estado.
- `db_password` queda en el estado local (`terraform.tfstate`) — no compartirlo ni subirlo (ya está en `.gitignore`).

### 2.1 Confirmar SNS (obligatorio para recibir alertas)

El `apply` crea la suscripción por correo del tema `docuprocess-dev-alerts`, pero queda en estado `PendingConfirmation` hasta que alguien abre el correo y confirma. Sin ese clic **no llegan los correos** aunque el worker publique (el log mostrará `sns_published`). Revisar el buzón del `alert_email` y confirmar antes de la demo.

### 2.2 Publicar el frontend

```bash
./scripts/deploy-frontend.sh
```

Comprueba credenciales y cuenta contra el tfstate (falla antes de escribir si la cuenta no coincide), construye con Vite, sincroniza `frontend/dist` a S3 (index/config sin caché, assets `immutable`), genera e inyecta `frontend/public/config.js` (`apiBaseUrl: ""`, mismo origen) e invalida `/*` en CloudFront. Imprime la URL pública al final. Si el dominio de CloudFront cambia respecto al CORS del bucket docs o a los valores del navegador, re-aplicar infra para refrescar `storage_cors_allowed_origins`.

### 2.3 Verificación de extremo a extremo

1. En navegador: `https://<cloudfront_domain>/` → registro, login.
2. Subir un PDF/PNG → el estado pasa a `DONE` (páginas/dimensiones/SHA-256 visibles) o `FAILED` si es corrupto.
3. API directa (sin caché):

   ```bash
   DOMAIN="$(terraform -chdir=infra output -raw cloudfront_domain_name)"
   curl -sS "https://$DOMAIN/api/health"     # {"status":"ok"}
   curl -sS "https://$DOMAIN/api/ready"      # MySQL check
   ```

4. EC2: ambas instancias `InService`/`Healthy` (ASG) y servicios activos por SSM:

   ```bash
   aws ssm send-command --document-name AWS-RunShellScript \
     --targets "Key=tag:aws:autoscaling:groupName,Values=docuprocess-dev-app-v1" \
     --parameters 'commands=["systemctl is-active docuprocess-api docuprocess-worker"]'
   ```

5. RDS `available` (Single-AZ, `db.t3.micro`); tablas DynamoDB `documents` y `document_events` `ACTIVE`; SNS `Delivered≥1` en CloudWatch (métrica `NumberOfNotificationsDelivered`).

### 2.4 Acceso sin SSH (Session Manager)

No hay puerto 22 ni llaves. Usar la consola AWS → **Systems Manager → Session Manager** → seleccionar la instancia, o:

```bash
aws ssm start-session --target <instance-id>
journalctl -u docuprocess-api -u docuprocess-worker -n 100
```

## 3. Destrucción y limpieza

```bash
terraform -chdir=infra destroy   # el provisioner terraform_data vacía los buckets (scripts/empty-bucket.sh)
```

- El estado local conserva referencias a recursos ya inexistentes: borrar `infra/terraform.tfstate*` **solo tras el destroy** y sobre una cuenta limpia.
- Si quedan buckets/tablas/alarmas "huérfanos" (de intentos fallidos), borrarlos antes del siguiente apply en una cuenta que se reutiliza: `terraform plan -refresh=true` primero.
- Nunca commitear `tfplan*.bin` ni `terraform.tfstate*` (está en `.gitignore`).

## 4. Solución de problemas

| Síntesis | Causa probable | Solución |
| --- | --- | --- |
| `InvalidClientTokenId` / `ExpiredToken` en cualquier paso | Sesión del lab expirada o `voc-cancel-cred` a mitad | Abrir el lab de nuevo → re-copiar credenciales → re-`export AWS_PROFILE=academy`; `terraform plan -refresh=true` y reaplicar (idempotente) |
| Precondición `dist/docuprocess-app.zip` no existe | Se saltó `package-app.sh` | `./scripts/package-app.sh` y re-`apply` |
| `ParameterAlreadyExists` en `aws_ssm_parameter.db_password` / `jwt_secret` | Despliegue previo en la misma cuenta dejó los parámetros | `aws ssm delete-parameter --name /docuprocess-dev/db_password` (y `jwt_secret`) o `terraform import`; nunca `overwrite` |
| Apply desde "cuenta vacía" falla por recursos sin tag | `voc-cancel-cred` u otro apply abortado dejó huérfanos (buckets, RDS, alarmas no etiquetados) | `terraform plan -refresh=true`; borrar huérfanos; aplicar de nuevo. Estado sano del repo: ~73 add / 0 change / 0 destroy |
| Alarmas CloudWatch sin correo destino | Suscripción SNS `PendingConfirmation` | Confirmar el correo (una sola vez por cuenta); reenviar confirmación con `aws sns resubscribe` si fue borrada |
| CloudFront responde **504** durante el relanzamiento | Draining/deregistration del target group tras reemplazo de instancias | Esperar 1–4 min; no re-aplicar en mitad de la demo; verificar `/api/health` en el ALB directamente |
| El documento queda `PROCESSING` para siempre y el frontend hace polling sin fin | El worker murió tras el claim (OOM, deploy, timeout) — no hay reaper | Resetear el ítem (sin tocar la bitácora, que es append-only): `aws dynamodb update-item --table-name documents --key '{"documentId":{"S":"<id>"}}' --update-expression "SET #s = :pending" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":pending":{"S":"PENDING"}}'` o borrar el ítem y re-subir. Mejor preparado: no matar el worker durante la demo |
| Alta de documento devuelve **503** | SCP del Sandbox deniega `dynamodb:TransactWriteItems` (o falta el permiso de recurso) | Activar `enable_dynamodb_transactions = false` en `terraform.tfvars` (escritura secuencial con evento de auditoría sin transacción; ver `docs/rds-vs-dynamodb.md`) y reaplicar/reiniciar worker |
| "Imagen: blank screen" al servir el frontend sin build | Se sirve `frontend/` crudo y `import.meta.env` es undefined | Siempre publicar con `deploy-frontend.sh` (Vite) y testear `dist/` |
| PUT prefirmado rechazado (403/CORS) | Origen no permitido en CORS del bucket docs, o Content-Type distinto al declarado | Re-aplicar infra (CORS incluye `https://<cloudfront_domain>`); subir con exactamente el `Content-Type` declarado |
| `db_password` expuesto en el estado local | `terraform.tfstate` del Sandbox | No compartir el archivo; destruir el entorno al cerrar el lab (§3) |
| `npm test` falla en CI con `amazonlinux:2023` | Cambio en disponibilidad del paquete `nodejs24` en AL2023 | Actualizar el CI al paquete disponible / fijar versión en `ci.yml` |
| GitHub Actions: trabajo "Secret scan" falla en repo de organización | `gitleaks-action@v2` requiere licencia en orgs | Usar el binario `gitleaks` en vez del action, o secret `GITLEAKS_LICENSE` |
| `ab`/`load-test.sh`: "falta '$cmd'" | Apache Bench no instalado | Debian/Ubuntu: `apt install apache2-utils`; AL2023/RHEL: `dnf install httpd-tools` |

## 5. Probar la carga del ASG (A8, opcional pero recomendado)

```bash
./scripts/load-test.sh                 # URL del ALB, 10 min, 50 concurrentes
LOG_DIR=./logs ./scripts/load-test.sh  # conservar ab.txt y el seguimiento del ASG
```

Satura `/api/auth/login` (bcrypt, costo 12) contra **el ALB** (no CloudFront) y muestra cada 30 s `DesiredCapacity`/`InService` y CPUUtilization del ASG. Esperar a que el escalado salte a 4 instancias (CPU media > 60 %). El scale-in tarda ~15 min tras cesar la carga. el informe que se produce al cerrar la tarea A8.

## 6. Checklist pre-demo (13 nov)

- [ ] `aws sts get-caller-identity` → cuenta del laboratorio.
- [ ] ASG 2/2 `InService` y `Healthy`; `https://<cloudfront>/api/health` 200.
- [ ] Suscripción SNS confirmada; `alert_email` es el buzón donde se demostrará la alerta.
- [ ] Sesión del lab iniciada con tiempo suficiente (credenciales no vencidas).
- [ ] `./scripts/deploy-frontend.sh` ejecutado y `config.js` verificado (`curl …/config.js` → `apiBaseUrl: ""`).
- [ ] Subida real PDF y PNG; corrupto → `FAILED`; documento ajeno → 404.
- [ ] Alarmas CloudWatch `docuprocess-dev-*` visibles en la consola (CPU EC2, RDS CPU/connections/storage) → publican a SNS (ver `docs/informe-b10.md` cuando B10 cierre su evidencia).
- [ ] `scripts/load-test.sh` corrido al menos una vez con evidencia capturada (A8).
