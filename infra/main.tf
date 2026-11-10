# Módulo raíz de DocuProcess Cloud.
# Las credenciales NO están aquí: se leen de ~/.aws/credentials (copiadas de AWS Academy en cada sesión).

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# awscc no soporta default_tags: los módulos le pasan local.common_tags explícitamente.
provider "awscc" {
  region = var.aws_region
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

# --- dynamodb (B3)

# --- sns (B4)

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
  # El userData se renderiza aquí (la raíz conoce los outputs de todos los módulos) y compute
  # lo recibe como texto. Los valores de módulos que aún no existen (storage, dynamodb, sns)
  # van vacíos hasta que B2, B3 y B6 lleguen a main; A4 los conecta.
  user_data = templatefile("${path.module}/../scripts/user-data.sh.tftpl", {
    aws_region       = var.aws_region
    db_host          = module.rds.db_address
    db_port          = module.rds.db_port
    db_name          = var.db_name
    db_user          = var.db_username
    ddb_table        = var.dynamodb_table_name
    docs_bucket      = ""
    sns_topic_arn    = ""
    artifacts_bucket = ""
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
  user_data             = local.user_data
}

# --- cdn (B5)

# --- monitoring (B9)
