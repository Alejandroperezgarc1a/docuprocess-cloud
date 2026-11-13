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

# Nombre del bucket S3 dedicado a CloudTrail.
output "cloudtrail_bucket_name" {
  description = "Nombre del bucket S3 dedicado a CloudTrail."
  value       = awscc_s3_bucket.cloudtrail.id
}

# ARN del trail de CloudTrail.
output "cloudtrail_arn" {
  description = "ARN del trail de CloudTrail."
  value       = aws_cloudtrail.this.arn
}