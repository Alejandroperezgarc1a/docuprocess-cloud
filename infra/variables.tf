# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

variable "aws_region" {
  description = "Región de AWS (el Sandbox opera en us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Nombre del proyecto; prefijo de todos los recursos."
  type        = string
  default     = "docuprocess"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.project_name))
    error_message = "project_name: minúsculas, números y guiones, entre 3 y 20 caracteres, empezando por letra (se usa en nombres de buckets)."
  }
}

variable "environment" {
  description = "Nombre del entorno (dev, demo...)."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.environment))
    error_message = "environment: minúsculas y números, entre 2 y 10 caracteres."
  }
}

# -----------------------------------------------------------------------------
# Red (A2)
# -----------------------------------------------------------------------------

variable "azs" {
  description = "Zonas de disponibilidad (exactamente 2)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.azs) == 2
    error_message = "azs debe tener exactamente 2 zonas."
  }
}

variable "vpc_cidr" {
  description = "CIDR de la VPC."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr debe ser un CIDR IPv4 válido."
  }
}

variable "public_subnet_cidrs" {
  description = "CIDR de las subredes públicas (ALB), una por AZ."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2 && alltrue([for c in var.public_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "public_subnet_cidrs: 2 CIDR IPv4 válidos."
  }
}

variable "private_subnet_cidrs" {
  description = "CIDR de las subredes privadas (EC2, RDS, endpoints), una por AZ."
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) == 2 && alltrue([for c in var.private_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "private_subnet_cidrs: 2 CIDR IPv4 válidos."
  }
}

variable "enable_nat_gateway" {
  description = "Crea un NAT Gateway para dar salida a internet a las subredes privadas. Desactivado por diseño (spike A1)."
  type        = bool
  default     = false
}

variable "enable_interface_endpoints" {
  description = "Crea interface endpoints (ssm, ssmmessages, ec2messages, sns). Necesarios si no hay NAT."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Cómputo (A3, A7)
# -----------------------------------------------------------------------------

variable "instance_type" {
  description = "Tipo de instancia de la app. El enunciado pide t2.micro/t3.micro; el Sandbox permite hasta medium."
  type        = string
  default     = "t3.micro"

  validation {
    condition     = contains(["t2.micro", "t2.small", "t2.medium", "t3.micro", "t3.small", "t3.medium"], var.instance_type)
    error_message = "instance_type: solo t2/t3 micro, small o medium (restricción del Sandbox)."
  }
}

variable "instance_role_name" {
  description = "Rol IAM preexistente de las instancias. Su instance profile se descubre automáticamente."
  type        = string
  default     = "AmazonSSMRoleForInstancesQuickSetup"
}

variable "asg_min_size" {
  description = "Mínimo de instancias del ASG."
  type        = number
  default     = 2

  validation {
    condition     = var.asg_min_size >= 1
    error_message = "asg_min_size debe ser al menos 1."
  }
}

variable "asg_max_size" {
  description = "Máximo de instancias del ASG (el Sandbox permite 9 en toda la cuenta)."
  type        = number
  default     = 4

  validation {
    condition     = var.asg_max_size <= 4 && var.asg_max_size >= var.asg_min_size
    error_message = "asg_max_size debe estar entre asg_min_size y 4."
  }
}

variable "asg_desired_capacity" {
  description = "Capacidad deseada inicial del ASG."
  type        = number
  default     = 2

  validation {
    condition     = var.asg_desired_capacity >= var.asg_min_size && var.asg_desired_capacity <= var.asg_max_size
    error_message = "asg_desired_capacity debe estar entre asg_min_size y asg_max_size."
  }
}

variable "cpu_target_value" {
  description = "Objetivo de CPU promedio (%) para el escalado por target tracking."
  type        = number
  default     = 60

  validation {
    condition     = var.cpu_target_value >= 10 && var.cpu_target_value <= 90
    error_message = "cpu_target_value debe estar entre 10 y 90."
  }
}

variable "root_volume_size" {
  description = "Tamaño (GB) del disco raíz gp2 de las instancias. El Sandbox niega gp3 y limita a 35 GB."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size >= 8 && var.root_volume_size <= 35
    error_message = "root_volume_size debe estar entre 8 y 35 GB."
  }
}

variable "app_artifact_path" {
  description = "Ruta (relativa a infra/) del zip que genera scripts/package-app.sh."
  type        = string
  default     = "../dist/docuprocess-app.zip"
}

# -----------------------------------------------------------------------------
# Base de datos (A5) y secretos (A4)
# -----------------------------------------------------------------------------

variable "db_name" {
  description = "Nombre de la base de datos MySQL."
  type        = string
  default     = "docuprocess"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,63}$", var.db_name))
    error_message = "db_name: letras, números y guion bajo, empezando por letra."
  }
}

variable "db_username" {
  description = "Usuario administrador de MySQL."
  type        = string
  default     = "docuadmin"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,15}$", var.db_username)) && lower(var.db_username) != "admin"
    error_message = "db_username: hasta 16 caracteres alfanuméricos, empezando por letra (y distinto de admin)."
  }
}

variable "db_password" {
  description = "Contraseña de MySQL. Se guarda en Parameter Store (SecureString)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.db_password) >= 12 && !can(regex("[/@\" ]", var.db_password))
    error_message = "db_password: mínimo 12 caracteres y sin / @ \" ni espacios (restricción de RDS)."
  }
}

variable "jwt_secret" {
  description = "Secreto para firmar los JWT. Se guarda en Parameter Store (SecureString)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret: mínimo 32 caracteres (generar con: openssl rand -hex 32)."
  }
}

# -----------------------------------------------------------------------------
# Datos y notificaciones (B2, B3, B4, B9)
# -----------------------------------------------------------------------------

variable "cors_allowed_origins" {
  description = "Orígenes permitidos para el PUT prefirmado al bucket de documentos."
  type        = list(string)
  default     = ["http://localhost:5500", "http://127.0.0.1:5500"]

  validation {
    condition = length(var.cors_allowed_origins) > 0 && alltrue([
      for origin in var.cors_allowed_origins :
      origin == "*" || can(regex("^https?://[^/]+$", origin))
    ])
    error_message = "cors_allowed_origins debe contener orígenes http(s) válidos o '*'."
  }
}

variable "dynamodb_table_name" {
  description = "Nombre de la tabla de documentos."
  type        = string
  default     = "documents"
}

variable "alert_email" {
  description = "Correo que recibe las notificaciones de SNS (documentos y alarmas)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email debe ser un correo válido."
  }
}

variable "force_destroy_buckets" {
  description = "Vacía los buckets antes de destruirlos (terraform_data + scripts/empty-bucket.sh)."
  type        = bool
  default     = true
}
