variable "name_prefix" {
  description = "Prefijo de los nombres de los recursos (por ejemplo docuprocess-dev)."
  type        = string
}

variable "frontend_bucket_name" {
  description = "Nombre del bucket S3 que contiene el frontend estático."
  type        = string
}

variable "frontend_bucket_arn" {
  description = "ARN del bucket del frontend; se usa en la política que autoriza a CloudFront."
  type        = string
}

variable "frontend_bucket_regional_domain_name" {
  description = "Dominio regional del bucket del frontend (origen S3 de CloudFront)."
  type        = string
}

variable "alb_dns_name" {
  description = "DNS público del ALB; origen de las peticiones /api/*."
  type        = string
}
