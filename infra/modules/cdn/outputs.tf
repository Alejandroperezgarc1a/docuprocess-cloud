output "cloudfront_domain_name" {
  description = "Dominio por defecto de la distribución; se usa en app_url y en el CORS del bucket de documentos."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_id" {
  description = "ID de la distribución (invalidaciones y operaciones de CloudFront)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "ARN de la distribución; lo usa la política del bucket del frontend."
  value       = aws_cloudfront_distribution.this.arn
}
