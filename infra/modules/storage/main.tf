# Buckets S3 de DocuProcess Cloud.
# Se usa awscc_s3_bucket porque el Sandbox niega s3:GetBucketObjectLockConfiguration,
# que aws_s3_bucket lee siempre. Los sub-recursos siguen siendo recursos de aws.

locals {
  bucket_names = {
    docs      = "${var.name_prefix}-docs-${random_id.suffix.hex}"
    frontend  = "${var.name_prefix}-frontend-${random_id.suffix.hex}"
    artifacts = "${var.name_prefix}-artifacts-${random_id.suffix.hex}"
  }

  empty_script = abspath("${path.root}/../scripts/empty-bucket.sh")
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "awscc_s3_bucket" "this" {
  for_each = local.bucket_names

  bucket_name = each.value
  tags = [
    for key, value in merge(var.common_tags, { Name = each.value }) : {
      key   = key
      value = value
    }
  ]
}

# Bloqueo de acceso público en los tres buckets.
resource "aws_s3_bucket_public_access_block" "this" {
  for_each = awscc_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Propiedad total del bucket (ACL deshabilitadas).
resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = awscc_s3_bucket.this

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Cifrado en reposo con SSE-S3.
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = awscc_s3_bucket.this

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CORS solo para las URLs prefirmadas del bucket de documentos.
resource "aws_s3_bucket_cors_configuration" "docs" {
  bucket = awscc_s3_bucket.this["docs"].id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["Content-Type"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# El bucket de artefactos conserva versiones para poder volver a un release anterior.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = awscc_s3_bucket.this["artifacts"].id

  versioning_configuration {
    status = "Enabled"
  }
}

# Regla opcional de retención de documentos. Desactivada por defecto.
resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  count = var.docs_lifecycle_expiration_days > 0 ? 1 : 0

  bucket = awscc_s3_bucket.this["docs"].id

  rule {
    id     = "expire-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = var.docs_lifecycle_expiration_days
    }
  }
}

# El rol de las EC2 solo tiene permisos de SSM: estos permisos van en los recursos.
data "aws_iam_policy_document" "docs" {
  statement {
    sid    = "AppUploads"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]

    resources = ["${awscc_s3_bucket.this["docs"].arn}/uploads/*"]

    principals {
      type        = "AWS"
      identifiers = [var.app_role_arn]
    }
  }
}

data "aws_iam_policy_document" "artifacts" {
  statement {
    sid    = "AppReleases"
    effect = "Allow"

    actions = [
      "s3:GetObject",
    ]

    resources = ["${awscc_s3_bucket.this["artifacts"].arn}/releases/*"]

    principals {
      type        = "AWS"
      identifiers = [var.app_role_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "docs" {
  bucket = awscc_s3_bucket.this["docs"].id
  policy = data.aws_iam_policy_document.docs.json

  depends_on = [
    aws_s3_bucket_public_access_block.this,
    aws_s3_bucket_ownership_controls.this,
  ]
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = awscc_s3_bucket.this["artifacts"].id
  policy = data.aws_iam_policy_document.artifacts.json

  depends_on = [
    aws_s3_bucket_public_access_block.this,
    aws_s3_bucket_ownership_controls.this,
  ]
}

# S3 exige vaciar un bucket antes de borrarlo. terraform_data se destruye antes
# que los buckets y ejecuta el script que elimina objetos, versiones y uploads
# multipart incompletos.
resource "terraform_data" "empty_buckets" {
  count = var.force_destroy_buckets ? 1 : 0

  triggers_replace = {
    docs      = awscc_s3_bucket.this["docs"].id
    frontend  = awscc_s3_bucket.this["frontend"].id
    artifacts = awscc_s3_bucket.this["artifacts"].id
    region    = var.aws_region
    script    = local.empty_script
  }

  depends_on = [awscc_s3_bucket.this]

  provisioner "local-exec" {
    when    = destroy
    command = "bash \"${self.triggers_replace.script}\" ${self.triggers_replace.docs} ${self.triggers_replace.frontend} ${self.triggers_replace.artifacts}"

    environment = {
      AWS_REGION = self.triggers_replace.region
    }
  }
}
