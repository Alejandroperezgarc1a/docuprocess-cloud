# Módulo CDN (B7): un solo dominio HTTPS de CloudFront para el frontend y la API.
# El frontend se sirve desde S3 con OAC; /api/* se reenvía al ALB sin caché.

locals {
  frontend_origin_id = "frontend-s3"
  api_origin_id      = "alb-api"
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.name_prefix}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Política administrada CachingOptimized. Se busca por nombre para no depender de un ID
# hardcodeado; el ID equivalente es 658327ea-f89d-4fab-a63d-7e88639e58f6.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  default_root_object = "index.html"

  # Cobertura de EE. UU., Canadá y Europa (menor costo). Si se exige cobertura
  # global estricta, cambiar a PriceClass_All.
  price_class = "PriceClass_100"

  origin {
    domain_name              = var.frontend_bucket_regional_domain_name
    origin_id                = local.frontend_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name = var.alb_dns_name
    origin_id   = local.api_origin_id

    # Sin dominio propio ni certificado ACM (restricción de Route53 del Sandbox):
    # CloudFront habla HTTP con el ALB, pero el navegador siempre ve HTTPS.
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Frontend: solo lectura y cacheado en los edges.
  default_cache_behavior {
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress               = true
  }

  # API: todos los métodos, sin caché y reenviando la identidad y el tipo de contenido.
  # forwarded_values (legacy) es la forma segura de reenviar Authorization con TTL 0.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
    compress    = false

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Origin"]

      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# El bucket sigue bloqueado para acceso público; esta política solo permite a CloudFront
# leer objetos de esta distribución concreta (AWS:SourceArn).
data "aws_iam_policy_document" "frontend" {
  statement {
    sid    = "AllowCloudFrontOAC"
    effect = "Allow"

    actions   = ["s3:GetObject"]
    resources = ["${var.frontend_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = var.frontend_bucket_name
  policy = data.aws_iam_policy_document.frontend.json

  depends_on = [aws_cloudfront_distribution.this]
}
