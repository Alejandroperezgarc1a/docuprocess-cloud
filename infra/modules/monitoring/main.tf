# -----------------------------------------------------------------------------
# Módulo monitoring (B10): alarmas CloudWatch y CloudTrail
# -----------------------------------------------------------------------------
# 4 alarmas: EC2 CPU, RDS CPU, RDS conexiones, RDS espacio libre.
# todas con period = 300, evaluation_periods = 2, statistic = Average,
# alarm_actions/ok_actions = [sns_topic_arn], treat_missing_data = "missing".
# CloudTrail: trail de una región, bucket S3 dedicado (awscc_s3_bucket),
# SSE-S3, política con s3:x-amz-acl y aws:SourceArn, enable_logging=true,
# include_global_service_events=true, enable_log_file_validation=true.
# Región fija us-east-1 (Sandbox). Los ARNs y nombres usan us-east-1.
# ----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# Región fija del Sandbox
locals {
  region = "us-east-1"

  account_id = data.aws_caller_identity.current.account_id

  # Nombre del bucket: name_prefix-cloudtrail-randomhex
  bucket_name = "${var.name_prefix}-cloudtrail-${random_id.suffix.hex}"

  # Nombre del trail
  trail_name = "${var.name_prefix}-cloudtrail"

  # ARN del trail: arn:aws:cloudtrail:region:account-id:trail/trail-name
  trail_arn = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.trail_name}"
}

# --- ID aleatorio para nombre único del bucket ---

resource "random_id" "suffix" {
  byte_length = 4
}

# --- 4 alarmas CloudWatch ---

# Alarma EC2 CPU con dimensión AutoScalingGroupName
resource "aws_cloudwatch_metric_alarm" "ec2_cpu" {
  alarm_name          = "${var.name_prefix}-ec2-cpu-high"
  alarm_description   = "CPU promedio del ASG ${var.asg_name} > ${var.ec2_cpu_threshold}% durante 10 min."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { AutoScalingGroupName = var.asg_name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.ec2_cpu_threshold
  alarm_actions       = [var.sns_topic_arn]
  ok_actions          = [var.sns_topic_arn]
  treat_missing_data  = "missing"
}

# Alarma RDS CPU
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu-high"
  alarm_description   = "CPU de RDS ${var.db_instance_identifier} > ${var.rds_cpu_threshold}% durante 10 min."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.rds_cpu_threshold
  alarm_actions       = [var.sns_topic_arn]
  ok_actions          = [var.sns_topic_arn]
  treat_missing_data  = "missing"
}

# Alarma RDS DatabaseConnections
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name_prefix}-rds-connections-high"
  alarm_description   = "Conexiones simultáneas a RDS ${var.db_instance_identifier} > ${var.rds_connections_threshold} durante 10 min."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.rds_connections_threshold
  alarm_actions       = [var.sns_topic_arn]
  ok_actions          = [var.sns_topic_arn]
  treat_missing_data  = "missing"
}

# Alarma RDS FreeStorageSpace (LessThanThreshold)
resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name_prefix}-rds-free-storage-low"
  alarm_description   = "Espacio libre de RDS ${var.db_instance_identifier} < 2 GiB durante 10 min."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = var.rds_free_storage_threshold_bytes
  alarm_actions       = [var.sns_topic_arn]
  ok_actions          = [var.sns_topic_arn]
  treat_missing_data  = "missing"
}

# --- CloudTrail y bucket S3 dedicado ---

# Buckets awscc (necesario porque el Sandbox deniega s3:GetBucketObjectLockConfiguration
# para aws_s3_bucket tradicional). Se usa ObjectWriter para que la condición
# s3:x-amz-acl = bucket-owner-full-control sea válida.
resource "awscc_s3_bucket" "cloudtrail" {
  bucket_name = local.bucket_name

  tags = [
    for key, value in merge(var.common_tags, { Name = local.bucket_name }) : {
      key   = key
      value = value
    }
  ]
}

# Bloqueo de acceso público
resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket = awscc_s3_bucket.cloudtrail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ObjectWriter (ACL habilitadas) para satisfacer la condición s3:x-amz-acl
resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = awscc_s3_bucket.cloudtrail.id

  rule {
    object_ownership = "ObjectWriter"
  }
}

# SSE-S3
resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = awscc_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Política CloudTrail: permite a cloudtrail.amazonaws.com hacer s3:GetBucketAcl y
# s3:PutObject en AWSLogs/<account_id>/* con s3:x-amz-acl = bucket-owner-full-control
# y la condición aws:SourceArn = trail ARN.
data "aws_iam_policy_document" "cloudtrail_policy" {
  statement {
    sid       = "AWSCloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [awscc_s3_bucket.cloudtrail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "AWSCloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${awscc_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

# Política S3 para el bucket de CloudTrail
resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = awscc_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_policy.json

  depends_on = [
    aws_s3_bucket_public_access_block.cloudtrail,
    aws_s3_bucket_ownership_controls.cloudtrail,
  ]
}

# Trail de CloudTrail (una sola región)
resource "aws_cloudtrail" "this" {
  name                          = local.trail_name
  s3_bucket_name                = awscc_s3_bucket.cloudtrail.id
  include_global_service_events = true
  enable_log_file_validation    = true
  is_multi_region_trail         = false
  enable_logging                = true

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

# terraform_data + local-exec para emular force_destroy (awscc no lo tiene nativo)
resource "terraform_data" "empty_cloudtrail_bucket" {
  count = var.force_destroy_buckets ? 1 : 0

  triggers_replace = {
    cloudtrail = awscc_s3_bucket.cloudtrail.id
  }

  input = {
    region = "us-east-1"
    script = abspath("${path.root}/../scripts/empty-bucket.sh")
  }

  depends_on = [awscc_s3_bucket.cloudtrail]

  provisioner "local-exec" {
    when    = destroy
    command = "bash \"${self.input.script}\" ${self.triggers_replace.cloudtrail}"

    environment = {
      AWS_REGION = self.input.region
    }
  }
}