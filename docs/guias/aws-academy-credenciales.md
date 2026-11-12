# Guia rapida: credenciales de AWS Academy para B2

## Por que necesito que hagas esto

El plan completo de Terraform se detiene porque la cuenta de AWS configurada
actualmente no tiene el rol ni el instance profile
`AmazonSSMRoleForInstancesQuickSetup`. Ese rol es obligatorio en el Sandbox y
no se puede crear desde Terraform.

B2 ya esta implementado y validado con `terraform validate` y un plan
`-target=module.storage`. Para probar los buckets reales necesito que la sesion
de AWS apunte a la cuenta del laboratorio correcta.

## Paso 1: abrir el laboratorio

1. Entra al curso en la plataforma de AWS Academy.
2. Abre **Learner Lab**.
3. Pulsa **Start Lab** y espera a que el indicador este en verde.
4. Abre **AWS Details**.

## Paso 2: copiar las credenciales CLI

1. En **AWS Details**, busca **AWS CLI**.
2. Pulsa **Show**.
3. Copia los tres valores:
   - `aws_access_key_id`
   - `aws_secret_access_key`
   - `aws_session_token`

No pegues estas credenciales en el chat ni en el repositorio.

## Paso 3: configurar el perfil local `academy`

El proyecto usa el perfil `academy` por defecto (`var.aws_profile = "academy"`).
Edita `~/.aws/credentials` y agrega o reemplaza el perfil `academy` con los
valores del laboratorio:

```ini
[academy]
aws_access_key_id = TU_ACCESS_KEY
aws_secret_access_key = TU_SECRET_KEY
aws_session_token = TU_SESSION_TOKEN
```

Edita `~/.aws/config` para que ese perfil use la región del proyecto:

```ini
[profile academy]
region = us-east-1
output = json
```

El proyecto usa `us-east-1` por defecto. Si tu laboratorio usa otra region,
dime cual para ajustar `terraform.tfvars` (`aws_region`).

## Paso 4: verificar la cuenta

Ejecuta:

```bash
export AWS_PROFILE=academy
aws sts get-caller-identity
```

Debe mostrar la cuenta del laboratorio, no la cuenta personal.

## Paso 5: verificar el rol obligatorio

Ejecuta:

```bash
aws iam list-instance-profiles --query 'InstanceProfiles[].InstanceProfileName' --output json
aws iam list-roles --query 'Roles[?contains(RoleName, `SSM`)].RoleName' --output json
```

Debe aparecer `AmazonSSMRoleForInstancesQuickSetup` o un nombre equivalente
indicado por el laboratorio.

## Paso 6: avisarme

Cuando las credenciales esten listas, dime solamente:

> Credenciales de AWS Academy listas

Con eso puedo ejecutar las pruebas pendientes:

1. `terraform apply -target=module.storage`
2. Verificar bloqueo publico, cifrado, ownership, CORS y versionado.
3. Subir objetos de prueba y comprobar que la URL publica devuelve 403.
4. `terraform destroy` para validar el vaciado de buckets.

## Si el rol no aparece

No intentes crear roles: el Sandbox es de solo lectura para IAM. En ese caso:

1. Copia el resultado de los dos comandos del Paso 5.
2. Pregunta al instructor por el nombre exacto del instance profile del
   laboratorio.
3. Enviame ese nombre y ajusto `instance_role_name` o el data source
   correspondiente en A2/A3.

## Alternativa si no usas AWS Academy

Puedes usar cualquier cuenta Sandbox que tenga el rol
`AmazonSSMRoleForInstancesQuickSetup` y permisos para crear S3, EC2, RDS,
DynamoDB, SNS y CloudWatch. Si el nombre del rol es distinto, enviame el nombre
exacto y lo adapto.
