variable "name_prefix" {
  description = "Prefijo de los nombres de los recursos (por ejemplo docuprocess-dev)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subredes privadas (2 AZ) del subnet group."
  type        = list(string)
}

variable "rds_security_group_id" {
  description = "Security group de RDS (A2): solo 3306 desde el SG de la app."
  type        = string
}

variable "db_name" {
  description = "Base de datos que se crea al lanzar la instancia."
  type        = string
}

variable "db_username" {
  description = "Usuario administrador de MySQL."
  type        = string
}

variable "db_password" {
  description = "Contraseña del usuario administrador."
  type        = string
  sensitive   = true
}

variable "backup_retention_period" {
  description = "Días de backups automáticos (0 los desactiva). 1 da point-in-time recovery mínimo."
  type        = number
  default     = 1
}
