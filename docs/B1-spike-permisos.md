# B1 · Spike de permisos del instance profile

> Este README explica en primera persona qué hice en el spike B1, por qué la rama
> no tiene código y dónde quedó el resultado.

## Qué hice

Hice un spike manual en la cuenta del Sandbox de AWS Academy (`us-east-1`) para
responder una pregunta concreta: **¿qué puede hacer realmente una EC2 con el
instance profile `AmazonSSMRoleForInstancesQuickSetup` sobre S3, DynamoDB y SNS,
si no puedo crear ni modificar roles?**

La pregunta no era teórica. La API y el worker dependen de esos servicios, y el
Sandbox solo permite usar roles preexistentes. Si el rol no puede escribir en S3,
leer o escribir en DynamoDB, o publicar en SNS, el flujo completo del proyecto no
funciona.

Para medirlo levanté una instancia temporal `t3.micro` con Amazon Linux 2023 en
una subred privada, con el instance profile, sin SSH (solo Session Manager) y con
disco raíz **gp2 de 20 GB**. Creé un bucket S3, una tabla DynamoDB con un GSI y un
tópico SNS con suscripción de correo.

Probé primero **sin políticas de recurso** (baseline), para ver qué hace el rol
solo con su identidad, y después **con políticas basadas en recursos**: bucket
policy en S3, resource policy en DynamoDB y topic policy en SNS. La idea era
comprobar si esas políticas eran suficientes para dar acceso al rol sin crear ni
modificar roles IAM.

## Qué probé

| Servicio | Acciones |
| --- | --- |
| S3 | `put-object`, `get-object`, `head-object`, `list-objects-v2`, GET prefirmado y PUT prefirmado |
| DynamoDB | `put-item`, `get-item`, `query` sobre el GSI y `update-item` con `--condition-expression` |
| SNS | `publish` a un tópico con suscripción de email |
| IAM | `get-role` (esperado denegado) y `list-instance-profiles-for-role` (necesario para descubrir el perfil) |
| STS | `get-caller-identity` desde la instancia privada (no alcanzable sin NAT/endpoint) |
| CloudWatch | `put-metric-data` (opcional; el PDF solo pide métricas nativas de EC2 y RDS) |
| Controles negativos | `list-buckets`, `scan`, `delete-item`, `describe-table`, `list-tables`, `list-topics`, PUT en `releases/*` |

## Por qué esta rama no tiene código

Porque B1 no es una funcionalidad: es una validación. El entregable es una
**matriz de permisos con evidencia**, no un módulo de Terraform ni código de
aplicación.

- Las pruebas se hicieron con AWS CLI y políticas JSON efímeras, fuera del
  repositorio.
- Los cambios de infraestructura que salgan de esto pertenecen a otras tareas
  (B2, B3, B4, B6, A4, A6).
- La matriz pasa a `docs/architecture.md` en B10.
- El issue de B1 dice explícitamente: *“Archivos que crea o modifica: Ninguno en
  el repositorio”*.

Por eso la rama `feat/B1-spike-permisos` no tiene commits de código. Este README
es la única excepción, para dejar constancia de por qué el spike no produce
código.

## Dónde quedó lo que hice

Los recursos de prueba eran temporales y los eliminé al terminar:

- Bucket S3 de prueba: vaciado y eliminado.
- Tabla DynamoDB de prueba: eliminada.
- Tópico SNS de prueba: eliminado (con su suscripción).
- Instancia EC2 temporal: terminada.
- Security group de la instancia: eliminado.

No quedó nada corriendo ni generando costo. No creé roles ni políticas IAM
permanentes. La VPC, las subredes y los endpoints eran de A1 y no los toqué.

La evidencia de las pruebas quedó en:

1. **El comentario del issue de B1**: matriz completa, mensajes exactos de
   `AccessDenied`, políticas aplicadas, salida de los comandos y checklist de
   limpieza. Es la fuente de verdad y la copia permanente.
2. **Un archivo temporal en S3**, antes de borrar el bucket:
   `uploads/evidence/b1-evidence.txt` dentro del bucket de prueba. Lo subí para sacar la
   evidencia de la instancia; como el bucket se eliminó, esa copia ya no existe
   en AWS. Lo que queda es el issue.
3. **La guía de ejecución** y este README, fuera de AWS, en el equipo local.

## Resultado

La matriz completa está en el issue de B1. No la duplico aquí para que no se
desactualice; el issue es la fuente de verdad.

En términos de diseño:

- Si las políticas de recurso funcionaron, queda validada la estrategia de
  `docs/architecture.md` §11: el rol solo tiene SSM y los permisos de datos se
  conceden en cada recurso.
- Si alguna acción quedó denegada, la alternativa está registrada en el issue y
  se coordina con A antes de cambiar los contratos de B6/A6.

## Cómo se reproduce

La guía paso a paso está en el PDF de ejecución que preparé aparte. En resumen:

1. Preflight en el portátil: identidad, `iam:GetRole`,
   `list-instance-profiles-for-role`, cuota de instancias, VPC y endpoints.
2. Crear bucket, tabla DynamoDB con GSI y tópico SNS con suscripción de email.
3. Lanzar la `t3.micro` en subred privada, con gp2 de 20 GB y SSM.
4. Ejecutar el baseline sin políticas.
5. Aplicar las políticas de recurso.
6. Ejecutar las pruebas positivas y los controles negativos.
7. Guardar la evidencia y pasarla al issue.
8. Eliminar los recursos de prueba, dejando intacta la red de A1.

## Estado de la rama

- Rama: `feat/B1-spike-permisos`.
- Sin commits de código.
- Sin cambios en `infra/`.
- Sin cambios en `docs/architecture.md` (eso es B10).
- El único archivo agregado sería este README, si el equipo decide conservarlo
  en el repositorio. Si se quiere respetar al pie de la letra el issue de B1, se
  puede dejar fuera del repo y usar el issue como registro.
