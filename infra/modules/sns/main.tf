# Tópico de alertas de DocuProcess Cloud (worker + alarmas CloudWatch).

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"
}
