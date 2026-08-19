output "instance_public_ip" {
  description = "Public IP of the backend VM. Set this as the SSH host in GitHub Actions secrets."
  value       = local.public_ip
}

output "instance_private_ip" {
  description = "Private IP inside the VCN."
  value       = oci_core_instance.backend.private_ip
}

output "instance_id" {
  description = "OCID of the compute instance."
  value       = oci_core_instance.backend.id
}

output "instance_shape" {
  description = "Shape actually deployed."
  value       = var.instance_shape
}

output "image_platform" {
  description = <<-EOT
    Docker platform the image must be built for. Set this as the BUILD_PLATFORM
    GitHub variable — building for the wrong architecture yields a container
    that dies at startup with "exec format error".
  EOT
  value       = local.image_platform
}

output "availability_domain" {
  description = "AD the instance actually landed in — useful when retrying Ampere capacity errors."
  value       = local.availability_domain
}

output "ssh_command" {
  description = "Admin login."
  value       = "ssh ubuntu@${local.public_ip}"
}

output "deploy_ssh_command" {
  description = "CI login, when a deploy key was supplied."
  value = (
    local.deploy_user_enabled
    ? "ssh ${local.deploy_user}@${local.public_ip}"
    : "deploy user disabled — set deploy_ssh_public_key to enable"
  )
}

output "app_dir" {
  description = "Directory on the VM the workflow deploys into."
  value       = local.app_dir
}

output "health_url" {
  description = "Canonical health endpoint, reachable once the workflow has deployed."
  value = (
    local.tls_enabled
    ? "https://${var.domain_name}/health"
    : "http://${local.public_ip}${var.expose_app_port ? ":${var.app_port}" : ""}/health"
  )
}

output "health_url_direct" {
  description = "Health endpoint bypassing Caddy — only while expose_app_port is true."
  value = (
    var.expose_app_port
    ? "http://${local.public_ip}:${var.app_port}/health"
    : "port ${var.app_port} is closed to the internet"
  )
}

# ---------------------------------------------------------------------------
# DNS — DPDNS exposes no API this configuration can drive, so the A record is a
# manual, one-time step. The reserved IP is what keeps it one-time.
# ---------------------------------------------------------------------------

output "dns_record_to_create" {
  description = "Create this record in the DigitalPlat dashboard, then deploy."
  value = (
    local.tls_enabled
    # Name is "@" — the DigitalPlat zone IS the full domain, so repeating the
    # subdomain in the record name puts it outside the zone and is rejected.
    ? "A  @  ->  ${local.public_ip}   (TTL 300, in zone ${var.domain_name})"
    : "domain_name is empty — no DNS record needed"
  )
}

output "app_url" {
  description = "Base URL to put in the frontend's VITE_API_BASE_URL."
  value = (
    local.tls_enabled
    ? "https://${var.domain_name}"
    : "http://${local.public_ip}${var.expose_app_port ? ":${var.app_port}" : ""}"
  )
}

# ---------------------------------------------------------------------------
# Registry coordinates — feed these into the workflow's secrets/vars.
# ---------------------------------------------------------------------------

output "ocir_namespace" {
  description = "Object Storage namespace, which doubles as the OCIR namespace."
  value       = data.oci_objectstorage_namespace.tenancy.namespace
}

output "ocir_repository" {
  description = "Fully qualified image name to push and pull."
  value = (
    var.create_container_repository
    ? "${local.ocir_endpoint}/${data.oci_objectstorage_namespace.tenancy.namespace}/${var.container_repository_name}"
    : "container repository disabled"
  )
}

output "ocir_endpoint" {
  description = "OCIR registry host for docker login."
  value       = local.ocir_endpoint
}

output "ocir_username" {
  description = "Username for `docker login` against OCIR. The password is an Auth Token, minted in the Console."
  value       = "${data.oci_objectstorage_namespace.tenancy.namespace}/<your-oci-username>"
}

# ---------------------------------------------------------------------------
# Convenience: the exact set of GitHub secrets the workflow expects.
# ---------------------------------------------------------------------------

output "github_secrets_checklist" {
  description = "Values to configure under GitHub > Settings > Secrets and variables > Actions."
  value = {
    OCI_HOST        = local.public_ip
    OCI_SSH_USER    = local.deploy_user_enabled ? local.deploy_user : "ubuntu"
    OCIR_REGISTRY   = local.ocir_endpoint
    OCIR_NAMESPACE  = data.oci_objectstorage_namespace.tenancy.namespace
    OCIR_REPOSITORY = var.container_repository_name
    APP_DIR         = local.app_dir
    BUILD_PLATFORM  = local.image_platform
    _notes = join(" ", [
      "Also set OCI_SSH_PRIVATE_KEY (the deploy keypair's private half),",
      "OCIR_USERNAME (<namespace>/<oci-username>, or <namespace>/oracleidentitycloudservice/<user> for federated logins),",
      "OCIR_TOKEN (Console > Profile > Auth Tokens), and the app secrets:",
      "DATABASE_URL, DIRECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY,",
      "SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWKS_URL.",
    ])
  }
}
