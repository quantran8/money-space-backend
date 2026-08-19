locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid

  # OCI protocol numbers (IANA): 1 = ICMP, 6 = TCP.
  protocol_tcp  = "6"
  protocol_icmp = "1"

  # DNS labels are alphanumeric-only and start with a letter, so "money-space"
  # has to lose its hyphen.
  dns_label = substr(replace(var.project_name, "/[^a-zA-Z0-9]/", ""), 0, 15)

  availability_domain = (
    var.availability_domain != ""
    ? var.availability_domain
    : data.oci_identity_availability_domains.ads.availability_domains[0].name
  )

  ssh_public_key_resolved_path = pathexpand(var.ssh_public_key_path)

  ssh_public_key = (
    var.ssh_public_key != ""
    ? var.ssh_public_key
    : file(local.ssh_public_key_resolved_path)
  )

  # Only the A1 shape takes a shape_config; E2.1.Micro's size is fixed.
  is_flex_shape = endswith(var.instance_shape, ".Flex")

  # Drives the --platform the deploy workflow builds for. A mismatch produces an
  # image that will not start on the instance ("exec format error"), so this is
  # surfaced as an output rather than left to be remembered.
  image_platform = local.is_flex_shape ? "linux/arm64" : "linux/amd64"

  # Caddy only requests a certificate when it has a name to request one for.
  tls_enabled = var.domain_name != ""

  # OCIR accepts the full region identifier as the registry host
  # (ap-singapore-1.ocir.io) alongside the three-letter key (sin.ocir.io), so no
  # region-key lookup table is needed.
  ocir_endpoint = "${var.region}.ocir.io"

  tags = {
    project   = var.project_name
    managedBy = "terraform"
  }
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Latest Ubuntu 22.04 image for whichever shape is selected. Filtering by shape
# is what keeps the architectures apart: an aarch64 image will not boot on
# E2.1.Micro, and an x86_64 image will not boot on A1.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# ---------------------------------------------------------------------------
# Compute — Ampere A1.Flex. Always Free grants 4 OCPU + 24 GB of A1 capacity
# per tenancy, which the defaults consume in one instance.
# ---------------------------------------------------------------------------

resource "oci_core_instance" "backend" {
  compartment_id      = local.compartment_id
  availability_domain = local.availability_domain
  display_name        = "${var.project_name}-backend"
  shape               = var.instance_shape
  freeform_tags       = local.tags

  # E2.1.Micro is a fixed shape — 1 OCPU / 1 GB, not configurable. Sending a
  # shape_config for it is rejected, so the block only exists for A1.
  dynamic "shape_config" {
    for_each = local.is_flex_shape ? [1] : []

    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gbs
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  create_vnic_details {
    subnet_id = oci_core_subnet.public.id

    # With a reserved IP the VNIC must launch bare: OCI allows only one public
    # address per VNIC, and an ephemeral one assigned at boot would block the
    # reserved address from ever attaching.
    assign_public_ip          = !var.use_reserved_ip
    assign_private_dns_record = true
    # Empty means "no internal DNS record", which is a valid way out of a
    # lingering hostname reservation.
    hostname_label = var.hostname_label != "" ? var.hostname_label : null
  }

  metadata = {
    ssh_authorized_keys = local.ssh_public_key
    user_data           = data.cloudinit_config.backend.rendered
  }

  # A new image release should not silently recreate a running instance; bump it
  # deliberately by tainting or by removing this line.
  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }
}
