# Salidas del módulo dynamodb: los nombres (DDB_TABLE / DDB_EVENTS_TABLE) y los
# ARNs (para depuración y políticas). La raíz lo reexporta para el userData.

output "table_name" {
  description = "Nombre de la tabla documents (DDB_TABLE de la app)."
  value       = aws_dynamodb_table.documents.name
}

output "table_arn" {
  description = "ARN de la tabla documents."
  value       = aws_dynamodb_table.documents.arn
}

output "events_table_name" {
  description = "Nombre de la tabla document_events (DDB_EVENTS_TABLE de la app)."
  value       = aws_dynamodb_table.events.name
}

output "events_table_arn" {
  description = "ARN de la tabla document_events."
  value       = aws_dynamodb_table.events.arn
}
