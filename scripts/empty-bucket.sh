#!/usr/bin/env bash
set -euo pipefail

# No se fija AWS_PROFILE: se usa el que tenga el llamador (Terraform hereda su
# entorno) o, si no hay, la cadena de credenciales por defecto de AWS.

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <bucket> [<bucket> ...]" >&2
  exit 2
fi

for bucket in "$@"; do
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "empty-bucket: $bucket no existe; se omite" >&2
    continue
  fi

  echo "empty-bucket: vaciando s3://$bucket" >&2

  # Borra los objetos actuales. En buckets versionados esto crea delete markers
  # que se eliminan en el siguiente bloque.
  aws s3 rm "s3://$bucket" --recursive --only-show-errors || true

  # Borra todas las versiones y delete markers.
  while true; do
    versions_json="$(aws s3api list-object-versions --bucket "$bucket" --max-items 1000 --output json)"
    count="$(printf '%s' "$versions_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(len(data.get("Versions", [])) + len(data.get("DeleteMarkers", [])))
')"
    [ "$count" -gt 0 ] || break

    delete_json="$(printf '%s' "$versions_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
objects = []
for item in data.get("Versions", []):
    objects.append({"Key": item["Key"], "VersionId": item["VersionId"]})
for item in data.get("DeleteMarkers", []):
    objects.append({"Key": item["Key"], "VersionId": item["VersionId"]})
print(json.dumps({"Objects": objects, "Quiet": True}))
')"
    aws s3api delete-objects --bucket "$bucket" --delete "$delete_json" >/dev/null
  done

  # Aborta uploads multipart incompletos.
  while true; do
    uploads_json="$(aws s3api list-multipart-uploads --bucket "$bucket" --max-items 1000 --output json)"
    count="$(printf '%s' "$uploads_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(len(data.get("Uploads", [])))
')"
    [ "$count" -gt 0 ] || break

    while IFS=$'\t' read -r key upload_id; do
      [ -n "$key" ] || continue
      aws s3api abort-multipart-upload --bucket "$bucket" --key "$key" --upload-id "$upload_id"
    done < <(printf '%s' "$uploads_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for item in data.get("Uploads", []):
    print("{}\t{}".format(item["Key"], item["UploadId"]))
')
  done
done
