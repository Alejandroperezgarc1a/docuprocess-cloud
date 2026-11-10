# Módulo compute (A3): ALB público -> target group :8000 -> ASG de instancias AL2023 privadas.
# Las instancias no tienen IP pública, llave SSH ni puerto 22: se administran con Session Manager.

# Tags por defecto del provider (Project, Environment, ManagedBy). Las instancias que lanza el ASG
# no los heredan solas, así que se propagan explícitamente en el ASG y en el launch template.
data "aws_default_tags" "this" {}

# Amazon Linux 2023 más reciente. Cambia con cada AMI nueva: eso crea otra versión del
# launch template y, con ella, un instance refresh (instancias siempre parcheadas).
data "aws_ami" "al2023" {
  owners      = ["amazon"]
  most_recent = true

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# -----------------------------------------------------------------------------
# Launch template: la "receta" de cada instancia
# -----------------------------------------------------------------------------

resource "aws_launch_template" "app" {
  name_prefix            = "${var.name_prefix}-app-"
  description            = "Instancias de la app de ${var.name_prefix}"
  image_id               = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  vpc_security_group_ids = [var.app_security_group_id]
  user_data              = base64encode(var.user_data)
  update_default_version = true
  # Sin key_name: no hay SSH. El acceso es por Session Manager.

  # El rol no se puede crear en el Sandbox; se usa el instance profile preexistente por nombre.
  iam_instance_profile {
    name = var.instance_profile_name
  }

  # IMDSv2 obligatorio: el servicio de metadatos (de donde salen las credenciales del rol)
  # exige un token de sesión, lo que bloquea los ataques SSRF que usan un simple GET.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # gp2 obligatorio: la AMI trae gp3 y el Sandbox niega RunInstances con gp3 (spike A1).
  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_type           = "gp2"
      volume_size           = var.root_volume_size
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(data.aws_default_tags.this.tags, { Name = "${var.name_prefix}-app" })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = merge(data.aws_default_tags.this.tags, { Name = "${var.name_prefix}-app" })
  }

  tags = { Name = "${var.name_prefix}-app" }
}

# -----------------------------------------------------------------------------
# Application Load Balancer
# -----------------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  # Descarta cabeceras HTTP mal formadas antes de que lleguen a la app.
  drop_invalid_header_fields = true

  tags = { Name = "${var.name_prefix}-alb" }
}

resource "aws_lb_target_group" "app" {
  name        = "${var.name_prefix}-app"
  port        = 8000
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  # Al sacar una instancia (escalado hacia abajo o refresh), el ALB espera 30 s a que terminen
  # las peticiones en curso antes de cortarla. El valor por defecto (300 s) haría lentos los refresh.
  deregistration_delay = 30

  health_check {
    path                = var.health_check_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name_prefix}-app" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  tags = { Name = "${var.name_prefix}-http" }
}

# -----------------------------------------------------------------------------
# Auto Scaling Group
# -----------------------------------------------------------------------------

resource "aws_autoscaling_group" "app" {
  name                = "${var.name_prefix}-app"
  vpc_zone_identifier = var.private_subnet_ids
  min_size            = var.asg_min_size
  max_size            = var.asg_max_size
  desired_capacity    = var.asg_desired_capacity
  target_group_arns   = [aws_lb_target_group.app.arn]

  # ELB: una instancia que no pasa el health check del ALB se reemplaza, aunque EC2 la vea "running".
  # El periodo de gracia da tiempo al userData (dnf, descarga del artefacto) antes de juzgarla.
  health_check_type         = "ELB"
  health_check_grace_period = 300

  # latest_version (un número) y no "$Latest" (un texto fijo): así, cuando cambia el launch template
  # (userData, AMI), cambia este atributo y Terraform dispara el instance refresh.
  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }

  # Reemplazo gradual: nunca baja de la mitad de la capacidad sana.
  instance_refresh {
    strategy = "Rolling"

    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 120
    }
  }

  # A7 ajustará desired_capacity con la política de escalado; que Terraform no lo revierta.
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-app"
    propagate_at_launch = true
  }

  dynamic "tag" {
    for_each = data.aws_default_tags.this.tags

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }
}
