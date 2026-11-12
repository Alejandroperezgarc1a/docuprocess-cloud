# Pruebas del módulo storage (B2)

Script de verificación de los tres buckets: bloqueo público, ownership,
cifrado, CORS, versionado, políticas, tags y privacidad de las URLs.

## Requisitos

- Credenciales del laboratorio activas (`AWS_PROFILE=academy`).
- `terraform apply -target=module.storage` ya ejecutado en `infra/`.
- `aws`, `jq`, `curl` y `python3` en el PATH.

## Uso

Desde la raíz del repositorio:

```bash
export AWS_PROFILE=academy
export AWS_REGION=us-east-1
./scripts/test-storage.sh
```

Sin argumentos lee los nombres de los buckets desde los outputs de Terraform.
También acepta los nombres explícitos:

```bash
./scripts/test-storage.sh <docs> <frontend> <artifacts>
```

El script sube un objeto temporal a `docs/uploads/test-storage/`, comprueba que
la URL pública devuelve 403, que la URL prefirmada devuelve 200 y lo elimina al
terminar. No modifica la configuración de los buckets.

## Lectura del resultado

- `ok:` comprobación correcta.
- `FALLA:` incidencia; el script termina con código distinto de cero.
- `info:` estado de la regla de ciclo de vida (informativo).

## Limpieza

```bash
cd infra
terraform destroy -target=module.storage -auto-approve
```

El `terraform_data` ejecuta `scripts/empty-bucket.sh` antes de borrar los
buckets, incluidos objetos versionados y uploads multipart incompletos.
