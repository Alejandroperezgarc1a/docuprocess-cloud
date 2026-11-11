output "docs_bucket_name" {
  description = "Nombre del bucket de documentos."
  value       = awscc_s3_bucket.this["docs"].id
}

output "docs_bucket_arn" {
  description = "ARN del bucket de documentos."
  value       = awscc_s3_bucket.this["docs"].arn
}

output "frontend_bucket_name" {
  description = "Nombre del bucket del frontend estático."
  value       = awscc_s3_bucket.this["frontend"].id
}

output "frontend_bucket_arn" {
  description = "ARN del bucket del frontend estático."
  value       = awscc_s3_bucket.this["frontend"].arn
}

output "frontend_bucket_regional_domain_name" {
  description = "Dominio regional del bucket del frontend (origen de CloudFront)."
  value       = awscc_s3_bucket.this["frontend"].regional_domain_name
}

output "artifacts_bucket_name" {
  description = "Nombre del bucket de artefactos (disponible cuando su bucket policy ya existe)."
  value       = awscc_s3_bucket.this["artifacts"].id
  depends_on  = [aws_s3_bucket_policy.artifacts]
}

output "artifacts_bucket_arn" {
  description = "ARN del bucket de artefactos."
  value       = awscc_s3_bucket.this["artifacts"].arn
}
