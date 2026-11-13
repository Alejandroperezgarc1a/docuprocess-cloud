# -----------------------------------------------------------------------------
# Outputs del módulo monitoring (B10)
# -----------------------------------------------------------------------------

# Nombres de las cuatro alarmas de CloudWatch.
output "alarm_names" {
  description = "Lista con los nombres de las cuatro alarmas de B10."
  value = [
    aws_cloudwatch_metric_alarm.ec2_cpu.alarm_name,
    aws_cloudwatch_metric_alarm.rds_cpu.alarm_name,
    aws_cloudwatch_metric_alarm.rds_connections.alarm_name,
    aws_cloudwatch_metric_alarm.rds_free_storage.alarm_name,
  ]
}

# Nombre del bucket S3 dedicado a CloudTrail (null en modo event-history).
output "cloudtrail_bucket_name" {
  description = "Nombre del bucket S3 dedicado a CloudTrail; null si cloudtrail_mode = event-history."
  value       = one(awscc_s3_bucket.cloudtrail[*].id)
}

# ARN del trail de CloudTrail (null en modo event-history).
output "cloudtrail_arn" {
  description = "ARN del trail de CloudTrail; null si cloudtrail_mode = event-history."
  value       = one(aws_cloudtrail.this[*].arn)
}

# Modo de auditoría CloudTrail en uso.
output "cloudtrail_audit_mode" {
  description = "Modo de auditoría CloudTrail: 'trail' o 'event-history'."
  value       = var.cloudtrail_mode
}
