output "alb_dns_name" {
  description = "Nombre DNS público del ALB (origen /api/* de CloudFront)."
  value       = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  description = "Sufijo del ARN del ALB (dimensión LoadBalancer de CloudWatch)."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  description = "Sufijo del ARN del target group (dimensión TargetGroup de CloudWatch)."
  value       = aws_lb_target_group.app.arn_suffix
}

output "asg_name" {
  description = "Nombre del Auto Scaling Group."
  value       = aws_autoscaling_group.app.name
}

output "launch_template_id" {
  description = "ID del launch template."
  value       = aws_launch_template.app.id
}
