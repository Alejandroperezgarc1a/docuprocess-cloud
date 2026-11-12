# Guia rapida: credenciales de AWS Academy

## Por que necesito que hagas esto

El plan completo de Terraform necesita el rol y el instance profile
`AmazonSSMRoleForInstancesQuickSetup` de la cuenta del laboratorio. Ese rol es
obligatorio en el Sandbox y no se puede crear desde Terraform.

Los modulos ya implementados se validan con `terraform validate` y planes
dirigidos. Para probar los recursos reales y completar la integracion, la
sesion de AWS debe apuntar a la cuenta del laboratorio correcta.

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

## Paso 3: configurar las credenciales locales

Por defecto el proyecto usa la cadena de credenciales de AWS (`var.aws_profile`
es `null`), así que lo más simple es pegar las credenciales del laboratorio en
el perfil `default`. Edita `~/.aws/credentials` y agrega o reemplaza ese perfil:

```ini
[default]
aws_access_key_id = TU_ACCESS_KEY
aws_secret_access_key = TU_SECRET_KEY
aws_session_token = TU_SESSION_TOKEN
```

Edita `~/.aws/config` para fijar la región del proyecto:

```ini
[default]
region = us-east-1
output = json
```

Si prefieres no usar `[default]`, guarda las credenciales en otro perfil y
expórtalo con `export AWS_PROFILE=<perfil>` o define `aws_profile = "<perfil>"`
en `infra/terraform.tfvars`. Terraform y los scripts usan el mismo perfil.

El proyecto usa `us-east-1` por defecto. Si tu laboratorio usa otra region,
dime cual para ajustar `terraform.tfvars` (`aws_region`).

## Paso 4: verificar la cuenta

Ejecuta:

```bash
aws sts get-caller-identity
```

Si usas un perfil distinto de `[default]`, exporta `AWS_PROFILE=<perfil>` antes
del comando (o define `aws_profile` en `terraform.tfvars`).

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

Cuando las credenciales esten listas, confirma que `aws sts get-caller-identity`
devuelve la cuenta del laboratorio. Con eso se pueden ejecutar los planes y
aplicaciones dirigidas de cada modulo, y despues la integracion end-to-end.

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
