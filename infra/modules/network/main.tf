# Módulo network (A2): VPC en 2 AZ, salida de las subredes privadas y security groups.
# Los security groups viven aquí y no en compute/rds para evitar el ciclo compute <-> rds:
# los dos módulos solo reciben los IDs ya creados.

locals {
  # Servicios con interface endpoint: los tres primeros los necesita el agente de SSM
  # (Session Manager y Run Command); sns lo usa el worker para publicar notificaciones.
  interface_services = var.enable_interface_endpoints ? toset(["ssm", "ssmmessages", "ec2messages", "sns"]) : toset([])

  # S3 (artefactos, documentos y repositorios de dnf) y DynamoDB: gateway endpoints, sin costo.
  gateway_services = toset(["s3", "dynamodb"])
}

# -----------------------------------------------------------------------------
# VPC y subredes
# -----------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr

  # Ambos en true: los necesita el private DNS de los interface endpoints
  # (ssm.us-east-1.amazonaws.com debe resolver a la IP privada del endpoint).
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_subnet" "public" {
  count = length(var.azs)

  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-public-${var.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count = length(var.azs)

  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.azs[count.index]

  tags = { Name = "${var.name_prefix}-private-${var.azs[count.index]}", Tier = "private" }
}

# -----------------------------------------------------------------------------
# Rutas: pública -> Internet Gateway; privada -> NAT (opcional) y gateway endpoints
# -----------------------------------------------------------------------------

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = length(var.azs)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Una sola tabla privada compartida: con un único NAT (o sin NAT) las dos AZ salen igual.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-private" }
}

resource "aws_route_table_association" "private" {
  count = length(var.azs)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- NAT opcional (desactivado por diseño, ver spike A1). Uno solo, en la primera AZ, para ahorrar costo.

resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  domain = "vpc"

  tags = { Name = "${var.name_prefix}-nat" }
}

resource "aws_nat_gateway" "this" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = { Name = "${var.name_prefix}-nat" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

# -----------------------------------------------------------------------------
# VPC endpoints
# -----------------------------------------------------------------------------

# Gateway: agrega a la tabla privada una ruta hacia la prefix list del servicio. Gratis.
# Política por defecto (acceso completo): los permisos reales los dan las políticas de cada recurso.
resource "aws_vpc_endpoint" "gateway" {
  for_each = local.gateway_services

  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name_prefix}-${each.key}" }
}

# Interface: una ENI con IP privada en cada subred privada; private DNS hace que el nombre
# público del servicio resuelva a esa IP, así el SDK y el agente de SSM no cambian nada.
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${var.name_prefix}-${each.key}" }
}

# -----------------------------------------------------------------------------
# Security groups encadenados por referencia: alb -> app -> rds
# Las reglas son recursos separados (aws_vpc_security_group_*_rule): una regla por recurso,
# sin reglas en línea, así Terraform no reescribe el grupo entero al cambiar una.
# -----------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "ALB publico: HTTP desde internet (CloudFront)"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP desde internet"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "Salida hacia los targets"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app"
  description = "EC2 de la app: solo el puerto 8000 desde el ALB; sin SSH (acceso por Session Manager)"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "API desde el ALB"
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
  referenced_security_group_id = aws_security_group.alb.id
}

# Salida abierta: endpoints (443), RDS (3306) y prefix lists de S3/DynamoDB.
# Sin NAT no hay ruta a internet, así que la red sigue cerrada hacia afuera.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Salida hacia endpoints, RDS, S3 y DynamoDB"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "RDS MySQL: solo 3306 desde las EC2 de la app"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-rds" }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  security_group_id            = aws_security_group.rds.id
  description                  = "MySQL desde la app"
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.app.id
}

# Sin regla de salida: RDS solo responde conexiones (los SG son stateful).

resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-endpoints"
  description = "Interface endpoints: HTTPS desde la VPC"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS desde la VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr
}
