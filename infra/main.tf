# Módulo raíz de DocuProcess Cloud.
# Las credenciales NO están aquí: se leen de la cadena de credenciales por defecto
# de AWS ([default] en ~/.aws/credentials, variables de entorno, SSO...). Si se
# necesita un perfil concreto, se define var.aws_profile (por defecto null).

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = local.common_tags
  }
}

# awscc no soporta default_tags: los módulos le pasan local.common_tags explícitamente.
provider "awscc" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "aws_caller_identity" "current" {}

# El instance profile del rol preexistente tiene un nombre generado distinto en cada cuenta
# (…-SsmRoleInstanceProfile-…). Se descubre a partir del nombre del rol con
# iam:ListInstanceProfilesForRole, que el Sandbox permite. No se usa data "aws_iam_role".
data "aws_iam_instance_profiles" "app" {
  role_name = var.instance_role_name

  lifecycle {
    postcondition {
      condition     = length(self.names) > 0
      error_message = "El rol ${var.instance_role_name} no tiene ningún instance profile en esta cuenta."
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  instance_profile_name = tolist(data.aws_iam_instance_profiles.app.names)[0]

  # ARN construido (sin consultar IAM). Los recursos de datos lo usan en sus políticas
  # basadas en recursos, porque el rol solo tiene permisos de SSM.
  app_role_arn = "arn:aws:iam::${local.account_id}:role/${var.instance_role_name}"
}

# -----------------------------------------------------------------------------
# Módulos. Cada tarea agrega su bloque en su propia sección para evitar conflictos de merge.
# -----------------------------------------------------------------------------

# --- network (A2)

module "network" {
  source = "./modules/network"

  name_prefix                = local.name_prefix
  aws_region                 = var.aws_region
  vpc_cidr                   = var.vpc_cidr
  azs                        = var.azs
  public_subnet_cidrs        = var.public_subnet_cidrs
  private_subnet_cidrs       = var.private_subnet_cidrs
  enable_nat_gateway         = var.enable_nat_gateway
  enable_interface_endpoints = var.enable_interface_endpoints
}

# --- storage (B2)

locals {
  # El dominio de CloudFront se suma a los orígenes locales para no romper el
  # desarrollo con Vite y la subida directa a S3 con URL prefirmada.
  storage_cors_allowed_origins = distinct(concat(
    var.cors_allowed_origins,
    ["https://${module.cdn.cloudfront_domain_name}"]
  ))
}

module "storage" {
  source = "./modules/storage"

  name_prefix                    = local.name_prefix
  aws_region                     = var.aws_region
  force_destroy_buckets          = var.force_destroy_buckets
  cors_allowed_origins           = local.storage_cors_allowed_origins
  app_role_arn                   = local.app_role_arn
  common_tags                    = local.common_tags
  docs_lifecycle_expiration_days = var.docs_lifecycle_expiration_days
}

# --- dynamodb (B3)

# Crea las dos tablas (documents y document_events) con sus GSIs y sus políticas de
# recurso. El rol de las instancias solo tiene SSM; por eso el acceso a datos se concede
# con políticas basadas en el recurso (ver modules/dynamodb/main.tf), no con IAM.
module "dynamodb" {
  source = "./modules/dynamodb"

  table_name                    = var.dynamodb_table_name
  events_table_name             = var.document_events_table_name
  app_role_arn                  = local.app_role_arn
  enable_point_in_time_recovery = var.enable_point_in_time_recovery
}

# --- sns (B6)

module "sns" {
  source = "./modules/sns"

  name_prefix  = local.name_prefix
  alert_email  = var.alert_email
  app_role_arn = local.app_role_arn
}

# --- rds (A5)

module "rds" {
  source = "./modules/rds"

  name_prefix           = local.name_prefix
  private_subnet_ids    = module.network.private_subnet_ids
  rds_security_group_id = module.network.rds_security_group_id
  db_name               = var.db_name
  db_username           = var.db_username
  db_password           = var.db_password
}

# --- compute (A3) + userData y artefacto (A4)

locals {
  # B2 ya está en main: la API recibe los dos buckets juntos (sin DOCS_BUCKET no arranca).
  docs_bucket_name      = module.storage.docs_bucket_name
  artifacts_bucket_name = module.storage.artifacts_bucket_name

  # B3 ya está integrado; el tópico de alertas de B6 alimenta al worker.
  sns_topic_arn = module.sns.topic_arn

  # B3: la app escribe en dos tablas (estado y bitácora). Estos locales se inyectan en
  # el userData -> /etc/docuprocess.env -> la API los lee como DDB_TABLE y
  # DDB_EVENTS_TABLE al arrancar.
  ddb_table        = module.dynamodb.table_name
  ddb_events_table = module.dynamodb.events_table_name

  # md5 del zip, o "" si no existe (la precondición de app_artifact explica qué hacer).
  app_artifact_md5 = fileexists(var.app_artifact_path) ? filemd5(var.app_artifact_path) : ""
}

# Secretos de la app en Parameter Store (SecureString, cifrados con la clave administrada aws/ssm).
# El userData los lee al arrancar: no viajan en el userData ni en el launch template. Si el
# parámetro ya existe fuera del estado (otro despliegue en la misma cuenta), el apply falla con
# ParameterAlreadyExists: borrarlo o importarlo (`overwrite` está obsoleto en el provider).
resource "aws_ssm_parameter" "db_password" {
  name        = "/${local.name_prefix}/db_password"
  description = "Contraseña de MySQL (RDS) de la API."
  type        = "SecureString"
  value       = var.db_password
}

resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${local.name_prefix}/jwt_secret"
  description = "Secreto con el que la API firma los JWT."
  type        = "SecureString"
  value       = var.jwt_secret
}

# Artefacto de la app (lo genera scripts/package-app.sh). La clave incluye el hash del zip:
# código nuevo -> clave nueva -> userData nuevo -> versión nueva del launch template -> ASG nuevo
# (reemplazo sin caída, ver modules/compute).
#
resource "aws_s3_object" "app_artifact" {
  bucket = local.artifacts_bucket_name
  key    = "releases/app-${local.app_artifact_md5}.zip"
  source = var.app_artifact_path
  # source_hash y no etag: el zip pesa más de 5 MB y se sube en partes (multipart), así que el ETag
  # de S3 no coincide con el md5 del archivo y el plan mostraría un cambio en cada ejecución.
  source_hash = local.app_artifact_md5

  lifecycle {
    precondition {
      condition     = local.app_artifact_md5 != ""
      error_message = "No existe ${var.app_artifact_path}: ejecutar ./scripts/package-app.sh antes de terraform apply."
    }
  }
}

locals {
  # El userData se renderiza aquí (la raíz conoce los outputs de todos los módulos) y compute
  # lo recibe como texto. Los nombres de los parámetros se pasan por referencia para que
  # Terraform los cree antes que el launch template. Sus versiones (no los valores) entran al
  # userData: rotar un secreto cambia la versión y reemplaza las instancias.
  user_data = templatefile("${path.module}/../scripts/user-data.sh.tftpl", {
    aws_region                 = var.aws_region
    db_password_param          = aws_ssm_parameter.db_password.name
    jwt_secret_param           = aws_ssm_parameter.jwt_secret.name
    db_password_version        = aws_ssm_parameter.db_password.version
    jwt_secret_version         = aws_ssm_parameter.jwt_secret.version
    db_host                    = module.rds.db_address
    db_port                    = module.rds.db_port
    db_name                    = var.db_name
    db_user                    = var.db_username
    ddb_table                  = local.ddb_table
    ddb_events_table           = local.ddb_events_table
    ddb_transactions           = var.enable_dynamodb_transactions ? "true" : "false"
    docs_bucket                = local.docs_bucket_name
    sns_topic_arn              = local.sns_topic_arn
    artifacts_bucket           = local.artifacts_bucket_name
    artifact_key               = aws_s3_object.app_artifact.key
    worker_poll_seconds        = var.worker_poll_seconds
    worker_batch_size          = var.worker_batch_size
    upload_timeout_minutes     = var.upload_timeout_minutes
    processing_timeout_minutes = var.processing_timeout_minutes
    max_file_mb                = var.max_file_mb
    admin_emails               = join(",", var.admin_emails)
  })
}

module "compute" {
  source = "./modules/compute"

  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  private_subnet_ids    = module.network.private_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  app_security_group_id = module.network.app_security_group_id
  instance_type         = var.instance_type
  instance_profile_name = local.instance_profile_name
  root_volume_size      = var.root_volume_size
  asg_min_size          = var.asg_min_size
  asg_max_size          = var.asg_max_size
  asg_desired_capacity  = var.asg_desired_capacity
  cpu_target_value      = var.cpu_target_value
  user_data             = local.user_data

  # La bucket policy de artifacts se gestiona mediante el depends_on del output
  # artifacts_bucket_name; quitar depends_on de módulo evita que cualquier cambio
  # en storage difiera los data sources (AMI, tags) a apply time y reemplace el ASG.
}

# --- cdn (B7)

module "cdn" {
  source = "./modules/cdn"

  name_prefix                          = local.name_prefix
  frontend_bucket_name                 = module.storage.frontend_bucket_name
  frontend_bucket_arn                  = module.storage.frontend_bucket_arn
  frontend_bucket_regional_domain_name = module.storage.frontend_bucket_regional_domain_name
  alb_dns_name                         = module.compute.alb_dns_name
}

# --- monitoring (B10)

module "monitoring" {
  source = "./modules/monitoring"

  name_prefix            = local.name_prefix
  asg_name               = module.compute.asg_name
  db_instance_identifier = module.rds.db_instance_identifier
  sns_topic_arn          = module.sns.topic_arn
  force_destroy_buckets  = var.force_destroy_buckets
  cloudtrail_mode        = var.cloudtrail_mode
  common_tags            = local.common_tags
}
