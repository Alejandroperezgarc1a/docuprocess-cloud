# Módulo dynamodb (B3): almacenamiento NoSQL de DocuProcess Cloud.
#
# Dos tablas con responsabilidades distintas:
#   documents       -> estado actual de cada documento y cola del worker (se actualiza).
#   document_events -> bitácora append-only de cambios de estado (no se actualiza ni se borra).
#
# Ambas son on-demand (PAY_PER_REQUEST): la carga de la demo es intermitente y no hay que
# aprovisionar capacidad. El cifrado usa la llave administrada por AWS (aws/dynamodb) porque
# el Sandbox no permite crear KMS keys propias.

resource "aws_dynamodb_table" "documents" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "documentId"

  # Solo se declaran atributos que son clave (tabla o índice): DynamoDB es schemaless para el resto.
  attribute {
    name = "documentId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  # Lista de documentos de un usuario, del más reciente al más antiguo.
  global_secondary_index {
    name            = "userId-createdAt"
    hash_key        = "userId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  # Cola del worker: los PENDING más antiguos primero.
  global_secondary_index {
    name            = "status-createdAt"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  server_side_encryption {
    # Sin kms_key_arn, DynamoDB usa la llave administrada por AWS (aws/dynamodb).
    enabled = true
  }

  # point_in_time_recovery permite restaurar la tabla a un segundo concreto de los últimos
  # 35 días. La variable existe porque el Sandbox podría denegarlo (ver docs/architecture.md, 12).
  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  # Laboratorio: las tablas se destruyen y recrean con terraform destroy/apply.
  deletion_protection_enabled = false

  tags = { Name = var.table_name }
}

# El rol de las instancias solo tiene permisos de SSM: los permisos de datos se conceden con
# una política basada en el recurso (spike A1). TransactWriteItems se usa para escribir el
# estado y su evento de auditoría en una sola operación atómica.
# TransactWriteItems no es una acción IAM: DynamoDB autoriza la transacción con las acciones
# de cada ítem (PutItem, UpdateItem, ConditionCheckItem, DeleteItem). No agregar
# "dynamodb:TransactWriteItems" a la política; AWS la rechaza como acción inválida.
resource "aws_dynamodb_resource_policy" "documents" {
  resource_arn = aws_dynamodb_table.documents.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AppDocumentsTableAndIndexes"
        Effect = "Allow"
        Principal = {
          AWS = var.app_role_arn
        }
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.documents.arn,
          "${aws_dynamodb_table.documents.arn}/index/*",
        ]
      },
    ]
  })
}

resource "aws_dynamodb_table" "events" {
  name         = var.events_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "documentId"
  range_key    = "eventAt"

  attribute {
    name = "documentId"
    type = "S"
  }

  # eventAt = ISO-8601 UTC con milisegundos + "#" + sufijo aleatorio. El sufijo evita que dos
  # eventos del mismo milisegundo se sobrescriban (la clave de ordenación debe ser única).
  attribute {
    name = "eventAt"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  # Día UTC (YYYY-MM-DD): permite auditar todos los cambios de un día sin hacer Scan.
  attribute {
    name = "eventDay"
    type = "S"
  }

  # Auditoría por usuario entre documentos.
  global_secondary_index {
    name            = "userId-eventAt"
    hash_key        = "userId"
    range_key       = "eventAt"
    projection_type = "ALL"
  }

  # Auditoría global por día: eventDay evita el hot partition de una clave constante.
  global_secondary_index {
    name            = "day-eventAt"
    hash_key        = "eventDay"
    range_key       = "eventAt"
    projection_type = "ALL"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  deletion_protection_enabled = false

  tags = { Name = var.events_table_name }
}

# La bitácora es inmutable desde la aplicación: la política NO concede UpdateItem ni DeleteItem.
# Solo Terraform (credenciales del Sandbox) puede destruirla.
resource "aws_dynamodb_resource_policy" "events" {
  resource_arn = aws_dynamodb_table.events.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AppDocumentEventsAppendOnly"
        Effect = "Allow"
        Principal = {
          AWS = var.app_role_arn
        }
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.events.arn,
          "${aws_dynamodb_table.events.arn}/index/*",
        ]
      },
    ]
  })
}
