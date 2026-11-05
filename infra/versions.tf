terraform {
  # >= 1.9: las validaciones de variables pueden referirse a otras variables
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Solo para crear buckets S3: el Sandbox niega s3:GetBucketObjectLockConfiguration
    # y el recurso aws_s3_bucket siempre lo lee (ver docs/architecture.md, sección 12).
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Sin backend remoto: estado local. Las cuentas del Sandbox son temporales y personales.
}
