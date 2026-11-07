variable "name_prefix" {
  description = "Prefijo de los nombres de los recursos (por ejemplo docuprocess-dev)."
  type        = string
}

variable "aws_region" {
  description = "Región de AWS; arma los nombres de servicio de los VPC endpoints."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR de la VPC."
  type        = string
}

variable "azs" {
  description = "Zonas de disponibilidad, una por pareja de subredes."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "CIDR de las subredes públicas (ALB, NAT opcional), en el mismo orden que azs."
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "CIDR de las subredes privadas (EC2, RDS, interface endpoints), en el mismo orden que azs."
  type        = list(string)
}

variable "enable_nat_gateway" {
  description = "Crea un NAT Gateway (en la primera AZ) y la ruta 0.0.0.0/0 de las subredes privadas."
  type        = bool
}

variable "enable_interface_endpoints" {
  description = "Crea los interface endpoints ssm, ssmmessages, ec2messages y sns en las subredes privadas."
  type        = bool
}
