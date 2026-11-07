output "vpc_id" {
  description = "ID de la VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Subredes públicas en el orden de azs (ALB)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Subredes privadas en el orden de azs (ASG y subnet group de RDS)."
  value       = aws_subnet.private[*].id
}

output "private_route_table_ids" {
  description = "Tablas de rutas privadas (una compartida)."
  value       = [aws_route_table.private.id]
}

output "alb_security_group_id" {
  description = "Security group del ALB."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group de las EC2 de la app."
  value       = aws_security_group.app.id
}

output "rds_security_group_id" {
  description = "Security group de RDS."
  value       = aws_security_group.rds.id
}
