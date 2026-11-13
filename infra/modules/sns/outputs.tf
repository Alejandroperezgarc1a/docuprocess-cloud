output "topic_arn" {
  description = "ARN del tópico de alertas."
  value       = aws_sns_topic.alerts.arn
}

output "topic_name" {
  description = "Nombre del tópico de alertas."
  value       = aws_sns_topic.alerts.name
}
