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

output "docs_bucket_name" {
  description = "Bucket de documentos de usuario (B2)."
  value       = module.storage.docs_bucket_name
}

output "frontend_bucket_name" {
  description = "Bucket del frontend estático (B2)."
  value       = module.storage.frontend_bucket_name
}

output "artifacts_bucket_name" {
  description = "Bucket de artefactos de la aplicación (B2)."
  value       = module.storage.artifacts_bucket_name
}

output "alb_dns_name" {
  description = "DNS público del ALB (A3). Con CloudFront (B5) el acceso normal es por app_url."
  value       = module.compute.alb_dns_name
}

output "cloudfront_domain_name" {
  description = "Dominio por defecto de CloudFront (B5); sirve el frontend y la API."
  value       = module.cdn.cloudfront_domain_name
}

output "cloudfront_distribution_id" {
  description = "ID de la distribución de CloudFront (B5); se usa para invalidar la caché (B8)."
  value       = module.cdn.distribution_id
}

output "app_url" {
  description = "URL HTTPS pública de la aplicación (frontend y API bajo el mismo dominio)."
  value       = "https://${module.cdn.cloudfront_domain_name}"
}

output "asg_name" {
  description = "Auto Scaling Group de la app (A3)."
  value       = module.compute.asg_name
}
