variable "table_name" {
  description = "Nombre de la tabla de documentos (estado y cola del worker)."
  type        = string
  default     = "documents"
}

variable "events_table_name" {
  description = "Nombre de la tabla de eventos (bitácora append-only de cambios de estado)."
  type        = string
  default     = "document_events"
}

variable "app_role_arn" {
  description = "ARN del rol de las instancias; las políticas de recurso le conceden acceso a datos."
  type        = string
}

variable "enable_point_in_time_recovery" {
  description = "Activa point-in-time recovery en ambas tablas. Poner en false si el Sandbox lo deniega."
  type        = bool
  default     = true
}
