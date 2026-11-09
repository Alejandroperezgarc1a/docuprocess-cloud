# Módulo rds (A5): MySQL para usuarios y autenticación (tabla users de la API).
# Vive en las subredes privadas y solo acepta conexiones desde el SG de la app (A2).
# El esquema no lo aplica Terraform: la API ejecuta app/api/schema.sql al arrancar.

# El subnet group dice en qué subredes puede vivir la instancia. RDS exige al menos 2 AZ
# aunque sea Single-AZ: así puede recrearla en la otra AZ o pasarla a Multi-AZ sin rehacer la red.
resource "aws_db_subnet_group" "this" {
  name        = "${var.name_prefix}-db"
  description = "Subredes privadas de ${var.name_prefix} para RDS"
  subnet_ids  = var.private_subnet_ids

  tags = { Name = "${var.name_prefix}-db" }
}

resource "aws_db_instance" "this" {
  identifier = "${var.name_prefix}-mysql"

  # Motor: misma versión mayor que el MySQL del docker-compose (8.0). RDS elige la menor por defecto
  # y la actualiza en la ventana de mantenimiento.
  engine                     = "mysql"
  engine_version             = "8.0"
  auto_minor_version_upgrade = true

  # Tamaño mínimo: la tabla users es pequeña y el Sandbox limita las clases de instancia.
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  storage_type      = "gp2" # el Sandbox niega gp3 (spike A1)
  storage_encrypted = true  # cifrado en reposo con la llave administrada aws/rds

  # Single-AZ: Multi-AZ duplica el costo y el tiempo de creación; para la demo basta una.
  multi_az = false

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  # Red: privada, sin IP pública, solo el SG de RDS.
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.rds_security_group_id]
  publicly_accessible    = false
  port                   = 3306

  backup_retention_period = var.backup_retention_period

  # Ciclo de vida de laboratorio: se destruye cada día y se recrea desde cero.
  skip_final_snapshot = true
  deletion_protection = false
  apply_immediately   = true

  tags = { Name = "${var.name_prefix}-mysql" }
}
