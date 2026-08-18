# ---------------------------------------------------------------------------
# Provider credentials
# ---------------------------------------------------------------------------

variable "tenancy_ocid" {
  description = "OCID of the tenancy (Console > Profile > Tenancy)."
  type        = string
}

variable "user_ocid" {
  description = "OCID of the user the API key belongs to."
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API signing key, e.g. aa:bb:cc:..."
  type        = string
}

variable "private_key_path" {
  description = "Path to the API signing private key PEM downloaded from the Console."
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "Home/target region identifier, e.g. ap-singapore-1, us-ashburn-1."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create resources in. Defaults to the tenancy root."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Naming & placement
# ---------------------------------------------------------------------------

variable "project_name" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "money-space"
}

variable "availability_domain" {
  description = <<-EOT
    Availability domain name to place the instance in. Empty picks the first AD
    in the region. Ampere capacity is per-AD, so if you hit "Out of host
    capacity", set this explicitly and retry other ADs.
  EOT
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Compute
#
# Two Always Free shapes are supported, because Ampere capacity in some regions
# is effectively unobtainable:
#
#   VM.Standard.A1.Flex     arm64, 1-4 OCPU, 1-24 GB — preferred, but frequently
#                           answers "Out of host capacity"
#   VM.Standard.E2.1.Micro  amd64, fixed 1 OCPU / 1 GB — weaker, but almost
#                           always available
#
# Switching between them changes the CPU architecture, so the deploy workflow
# must build for a matching platform. `terraform output image_platform` prints
# the value to use.
# ---------------------------------------------------------------------------

variable "instance_shape" {
  description = "Compute shape. VM.Standard.A1.Flex (arm64) or VM.Standard.E2.1.Micro (amd64)."
  type        = string
  default     = "VM.Standard.A1.Flex"

  validation {
    condition = contains([
      "VM.Standard.A1.Flex",
      "VM.Standard.E2.1.Micro",
    ], var.instance_shape)
    error_message = "instance_shape must be VM.Standard.A1.Flex or VM.Standard.E2.1.Micro."
  }
}

variable "instance_ocpus" {
  description = <<-EOT
    OCPUs, for the flexible A1 shape only. The Always Free allowance is 4 OCPU
    across the tenancy; 1 is plenty for Nest + Redis and leaves the rest for
    other instances. Ignored by VM.Standard.E2.1.Micro, which is fixed at
    1 OCPU / 1 GB.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.instance_ocpus >= 1 && var.instance_ocpus <= 80
    error_message = "instance_ocpus must be between 1 and 80."
  }
}

variable "instance_memory_gbs" {
  description = <<-EOT
    Memory in GB, for the flexible A1 shape only. A1 allows up to 64 GB per
    OCPU, and the Always Free allowance is 24 GB across the tenancy. Ignored by
    VM.Standard.E2.1.Micro.
  EOT
  type        = number
  default     = 4

  validation {
    condition     = var.instance_memory_gbs >= 1 && var.instance_memory_gbs <= 1024
    error_message = "instance_memory_gbs must be between 1 and 1024."
  }
}

variable "boot_volume_size_gbs" {
  description = "Boot volume size. Always Free block storage totals 200 GB across all volumes."
  type        = number
  default     = 50
}

# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

variable "ssh_public_key" {
  description = "SSH public key authorised for the 'ubuntu' user. Empty reads ssh_public_key_path."
  type        = string
  default     = ""
}

variable "ssh_public_key_path" {
  description = "Path to an SSH public key, used when ssh_public_key is empty."
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "deploy_ssh_public_key" {
  description = <<-EOT
    Public key of the dedicated deploy keypair GitHub Actions authenticates
    with. Authorised for the 'deploy' user, which is limited to the app
    directory and the docker group. Empty disables the deploy user, leaving only
    the 'ubuntu' login.
  EOT
  type        = string
  default     = ""
}

variable "ssh_source_cidr" {
  description = <<-EOT
    CIDR allowed to reach port 22. Defaults to the whole internet because GitHub
    Actions runners have no stable egress range; narrow it if you deploy from a
    self-hosted runner with a fixed IP.
  EOT
  type        = string
  default     = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# Application surface
# ---------------------------------------------------------------------------

variable "hostname_label" {
  description = <<-EOT
    DNS label for the instance inside the VCN (<label>.public.<vcn>.oraclevcn.com).

    Worth knowing: OCI holds the label for a while after an instance is deleted,
    and a fresh launch then fails with "Hostname <label> is already used in
    subnet". That happens easily when a create is interrupted and rolled back.
    Change this value to get moving again rather than waiting for the release —
    nothing outside the VCN depends on it, since the public address comes from
    the reserved IP and the domain.

    Empty disables the internal DNS record entirely, which also sidesteps the
    clash.
  EOT
  type        = string
  default     = "backend"
}

variable "app_port" {
  description = "Port the Nest app listens on. Compose publishes it on the host."
  type        = number
  default     = 3000
}

variable "expose_app_port" {
  description = <<-EOT
    Open var.app_port to the internet in addition to 80/443. Handy while DNS is
    still propagating and for debugging past Caddy. Flip to false once HTTPS is
    confirmed working, so the backend is only reachable through TLS.
  EOT
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Public address & TLS
# ---------------------------------------------------------------------------

variable "use_reserved_ip" {
  description = <<-EOT
    Give the instance a RESERVED public IP instead of an ephemeral one. The DNS
    A record is maintained by hand on DigitalPlat DPDNS, so the address must
    survive a stop/start — an ephemeral IP can change and would break both DNS
    and the issued certificate. Included in Always Free.
  EOT
  type        = bool
  default     = true
}

variable "domain_name" {
  description = <<-EOT
    FQDN served over HTTPS, e.g. moneytogether.dpdns.org. Caddy obtains and
    renews a Let's Encrypt certificate for it automatically, provided the name
    already resolves to this instance's public IP. Leave empty to serve plain
    HTTP only.
  EOT
  type        = string
  default     = ""
}

variable "acme_email" {
  description = <<-EOT
    Contact address Let's Encrypt uses for expiry and problem notices. Optional:
    empty means Caddy registers the ACME account anonymously.
  EOT
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Container registry — OCIR, so GitHub Actions has somewhere to push the image
# the VM then pulls. Always Free includes a container registry.
# ---------------------------------------------------------------------------

variable "create_container_repository" {
  description = "Create an OCIR repository for the backend image."
  type        = bool
  default     = true
}

variable "container_repository_name" {
  description = "OCIR repository name. Full path becomes <region-key>.ocir.io/<namespace>/<name>."
  type        = string
  default     = "money-space-backend"
}

variable "container_repository_is_public" {
  description = "Allow anonymous pulls. Keep false so the VM must authenticate."
  type        = bool
  default     = false
}
