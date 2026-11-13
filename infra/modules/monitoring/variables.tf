# -----------------------------------------------------------------------------
# Módulo monitoring (B10): alarmas CloudWatch y CloudTrail
# -----------------------------------------------------------------------------

variable "name_prefix" {
  description = "Prefijo de nombres (por ejemplo docuprocess-dev)."
  type        = string
}

variable "asg_name" {
  description = "Nombre del Auto Scaling Group (A3): dimensión AutoScalingGroupName en la alarma de EC2 CPU."
  type        = string
}

variable "db_instance_identifier" {
  description = "Identificador de la instancia RDS (A5): dimensión DBInstanceIdentifier en las alarmas de RDS."
  type        = string
}

variable "sns_topic_arn" {
  description = "ARN del tópico SNS de alertas (B6)."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:", var.sns_topic_arn))
    error_message = "sns_topic_arn debe ser un ARN de SNS válido."
  }
}

variable "force_destroy_buckets" {
  description = "Vaciar el bucket de CloudTrail antes de destruirlo (terraform_data + scripts/empty-bucket.sh)."
  type        = bool
}

variable "cloudtrail_mode" {
  description = "Modo de auditoría CloudTrail: 'trail' crea bucket S3 + aws_cloudtrail; 'event-history' usa el historial de eventos de CloudTrail (compatible con el Sandbox, que deniega cloudtrail:CreateTrail)."
  type        = string
  default     = "event-history"

  validation {
    condition     = contains(["trail", "event-history"], var.cloudtrail_mode)
    error_message = "cloudtrail_mode debe ser 'trail' o 'event-history'."
  }
}

variable "ec2_cpu_threshold" {
  description = "Umbral (%) de CPU promedio del ASG (alarma EC2)."
  type        = number
  default     = 80

  validation {
    condition     = var.ec2_cpu_threshold > 0 && var.ec2_cpu_threshold <= 100
    error_message = "ec2_cpu_threshold debe estar entre 1 y 100."
  }
}

variable "rds_cpu_threshold" {
  description = "Umbral (%) de CPU de RDS (alarma RDS CPU)."
  type        = number
  default     = 80

  validation {
    condition     = var.rds_cpu_threshold > 0 && var.rds_cpu_threshold <= 100
    error_message = "rds_cpu_threshold debe estar entre 1 y 100."
  }
}

variable "rds_connections_threshold" {
  description = "Umbral de conexiones simultáneas a RDS (alarma RDS DatabaseConnections)."
  type        = number
  default     = 50

  validation {
    condition     = var.rds_connections_threshold >= 1
    error_message = "rds_connections_threshold debe ser al menos 1."
  }
}

variable "rds_free_storage_threshold_bytes" {
  description = "Umbral de espacio libre de RDS en bytes (2 GiB = 2147483648 por defecto; alarma LessThanThreshold)."
  type        = number
  default     = 2147483648

  validation {
    condition     = var.rds_free_storage_threshold_bytes > 0
    error_message = "rds_free_storage_threshold_bytes debe ser positivo."
  }
}

variable "common_tags" {
  description = "Etiquetas comunes. awscc no soporta default_tags."
  type        = map(string)
  default     = {}
}