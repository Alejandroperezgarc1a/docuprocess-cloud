variable "name_prefix" {
  description = "Prefijo del nombre del tópico (por ejemplo docuprocess-dev)."
  type        = string
}

variable "alert_email" {
  description = "Correo que recibe las notificaciones del worker y de las alarmas."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email debe ser un correo válido."
  }
}

variable "app_role_arn" {
  description = "ARN del rol de las EC2; recibe sns:Publish en la política del tópico."
  type        = string
}
