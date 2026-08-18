# ---------------------------------------------------------------------------
# Host bootstrap. Deliberately thin: Docker, a deploy user, a writable app
# directory. The application, its .env and its compose file arrive over SSH from
# the GitHub Actions workflow, so no secret is ever rendered into user_data —
# which Terraform would otherwise store verbatim in state.
# ---------------------------------------------------------------------------

locals {
  app_dir             = "/opt/${var.project_name}"
  deploy_user         = "deploy"
  deploy_user_enabled = var.deploy_ssh_public_key != ""
}

data "cloudinit_config" "backend" {
  # OCI caps user_data at 16 KB raw; gzip+base64 keeps plenty of headroom.
  gzip          = true
  base64_encode = true

  part {
    content_type = "text/cloud-config"
    filename     = "cloud-config.yaml"

    content = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
      app_dir               = local.app_dir
      deploy_user           = local.deploy_user
      deploy_user_enabled   = local.deploy_user_enabled
      deploy_ssh_public_key = trimspace(var.deploy_ssh_public_key)
      domain_name           = var.domain_name
    })
  }
}
