# Tópico de alertas de DocuProcess Cloud (worker + alarmas CloudWatch).
#
# La suscripción de correo queda en PendingConfirmation hasta que el destinatario
# pulsa el enlace del correo de AWS. Terraform no puede confirmarla ni borrar una
# suscripción sin confirmar: se elimina al destruir el tópico. Confirmar el correo
# antes de probar el envío.
#
# aws_sns_topic_policy reemplaza la política por defecto del tópico. Por eso se
# conceden explícitamente los dos publicadores: el rol de las EC2 (worker) y el
# servicio CloudWatch (alarmas de B9). No se usa sns:*: SNS rechaza acciones
# fuera del ámbito del servicio (spike A1).

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid    = "AllowAppPublish"
    effect = "Allow"

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "AWS"
      identifiers = [var.app_role_arn]
    }
  }

  statement {
    sid    = "AllowCloudWatchPublish"
    effect = "Allow"

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json

  # La suscripción se crea primero con la política por defecto (el dueño puede
  # suscribirse) y después se reemplaza por la política mínima.
  depends_on = [aws_sns_topic_subscription.email]
}
