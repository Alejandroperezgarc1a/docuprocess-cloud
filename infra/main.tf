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

module "storage" {
  source = "./modules/storage"

  name_prefix                    = local.name_prefix
  aws_region                     = var.aws_region
  force_destroy_buckets          = var.force_destroy_buckets
  cors_allowed_origins           = var.cors_allowed_origins
  app_role_arn                   = local.app_role_arn
  common_tags                    = local.common_tags
  docs_lifecycle_expiration_days = var.docs_lifecycle_expiration_days
}

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

# --- cdn (B5)

# --- monitoring (B9)
