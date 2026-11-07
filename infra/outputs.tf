# Outputs raíz. Cada tarea agrega los suyos (ver docs/architecture.md, sección 10):
# alb_dns_name, cloudfront_domain_name, cloudfront_distribution_id, app_url, docs_bucket_name,
# frontend_bucket_name, artifacts_bucket_name, dynamodb_table_name, sns_topic_arn, rds_endpoint,
# asg_name, vpc_id.

output "account_id" {
  description = "Cuenta de AWS donde se despliega (útil para no confundir sesiones del Sandbox)."
  value       = local.account_id
}

output "instance_profile_name" {
  description = "Instance profile descubierto a partir de instance_role_name."
  value       = local.instance_profile_name
}

output "app_role_arn" {
  description = "ARN del rol de las instancias; lo usan las políticas basadas en recursos."
  value       = local.app_role_arn
}

output "vpc_id" {
  description = "VPC de la aplicación (A2)."
  value       = module.network.vpc_id
}

output "rds_endpoint" {
  description = "Nombre DNS de la base MySQL (A5). Solo es alcanzable desde la app."
  value       = module.rds.db_address
}
