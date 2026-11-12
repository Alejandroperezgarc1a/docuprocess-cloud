# Contrato del módulo dynamodb (B3): solo los nombres de las tablas, el ARN del rol
# de las instancias y el interruptor de PITR. El módulo NO crea roles ni KMS keys
# (el Sandbox no lo permite); el cifrado usa la llave administrada por AWS.

variable "table_name" {
  description = "Nombre de la tabla de documentos (estado y cola del worker)."
  type        = string
  # Mismo nombre que consume la API (DDB_TABLE); el default permite usar la
  # cuenta sin overrides en un entorno nuevo.
  default = "documents"
}

variable "events_table_name" {
  description = "Nombre de la tabla de eventos (bitácora append-only de cambios de estado)."
  type        = string
  # Mismo nombre que consume la API (DDB_EVENTS_TABLE). Separada de documents para
  # que el historial sea inmutable sin arrastrar el estado actual.
  default = "document_events"
}

variable "app_role_arn" {
  description = "ARN del rol de las instancias; las políticas de recurso le conceden acceso a datos."
  type        = string
  # Sin default: hay que pasarlo explícitamente. El rol solo tiene permisos de SSM;
  # el acceso a DynamoDB llega vía políticas basadas en el recurso (ver main.tf).
}

# PITR (point_in_time_recovery) restaura la tabla a un segundo exacto de los últimos
# 35 días. Se controla por variable porque el Sandbox podría denegarlo por SCP; en
# ese caso se pone en false y el resto del módulo sigue igual.
variable "enable_point_in_time_recovery" {
  description = "Activa point-in-time recovery en ambas tablas. Poner en false si el Sandbox lo deniega."
  type        = bool
  default     = true
}
