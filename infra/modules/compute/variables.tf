variable "name_prefix" {
  description = "Prefijo de los nombres de los recursos (por ejemplo docuprocess-dev)."
  type        = string
}

variable "vpc_id" {
  description = "VPC del target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subredes públicas del ALB (2 AZ)."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subredes privadas donde el ASG lanza las instancias (2 AZ)."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "Security group del ALB (A2)."
  type        = string
}

variable "app_security_group_id" {
  description = "Security group de las instancias (A2): solo 8000 desde el ALB."
  type        = string
}

variable "instance_type" {
  description = "Tipo de instancia (validado en la raíz)."
  type        = string
}

variable "instance_profile_name" {
  description = "Instance profile del rol preexistente (descubierto en la raíz)."
  type        = string
}

variable "root_volume_size" {
  description = "Tamaño en GB del disco raíz gp2."
  type        = number
}

variable "asg_min_size" {
  description = "Mínimo de instancias."
  type        = number
}

variable "asg_max_size" {
  description = "Máximo de instancias."
  type        = number
}

variable "asg_desired_capacity" {
  description = "Capacidad deseada inicial."
  type        = number
}

variable "user_data" {
  description = "Script de arranque ya renderizado en la raíz (texto plano; aquí se codifica en base64)."
  type        = string
}

variable "health_check_path" {
  description = "Ruta del health check del target group (superficial: no toca la base)."
  type        = string
  default     = "/api/health"
}
