output "db_address" {
  description = "Nombre DNS de la instancia (DB_HOST de la app). Resuelve a una IP privada."
  value       = aws_db_instance.this.address
}

output "db_port" {
  description = "Puerto de MySQL (DB_PORT de la app)."
  value       = aws_db_instance.this.port
}

output "db_instance_identifier" {
  description = "Identificador de la instancia (dimensión DBInstanceIdentifier de las alarmas de B10)."
  value       = aws_db_instance.this.identifier
}
