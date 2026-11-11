variable "name_prefix" {
  description = "Prefijo de los nombres de los buckets (por ejemplo docuprocess-dev)."
  type        = string
}

variable "aws_region" {
  description = "Región de AWS; se usa en el dominio regional del frontend y en el script de vaciado."
  type        = string
}

variable "force_destroy_buckets" {
  description = "Vacía los buckets antes de destruirlos (terraform_data + scripts/empty-bucket.sh). Al desactivarla en un despliegue vivo, terraform_data se destruye y vacía los buckets una vez."
  type        = bool
}

variable "cors_allowed_origins" {
  description = "Orígenes permitidos para el PUT prefirmado al bucket de documentos."
  type        = list(string)

  validation {
    condition = length(var.cors_allowed_origins) > 0 && alltrue([
      for origin in var.cors_allowed_origins :
      origin == "*" || can(regex("^https?://[^/]+$", origin))
    ])
    error_message = "cors_allowed_origins debe contener orígenes http(s) válidos o '*'."
  }
}

variable "app_role_arn" {
  description = "ARN del rol de las instancias; recibe permisos de lectura/escritura en los buckets."
  type        = string
}

variable "common_tags" {
  description = "Etiquetas comunes. awscc no soporta default_tags, así que se pasan explícitamente."
  type        = map(string)
  default     = {}
}

variable "docs_lifecycle_expiration_days" {
  description = "Días para expirar objetos bajo uploads/ en el bucket de documentos. 0 desactiva la regla."
  type        = number
  default     = 0

  validation {
    condition     = var.docs_lifecycle_expiration_days >= 0
    error_message = "docs_lifecycle_expiration_days debe ser 0 o un número positivo."
  }
}
