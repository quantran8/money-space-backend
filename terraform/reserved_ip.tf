# ---------------------------------------------------------------------------
# Reserved public IP.
#
# The domain lives on DigitalPlat DPDNS, whose nameservers expose no API this
# configuration can drive, so the A record is created by hand exactly once. That
# only stays true if the address never changes — hence a RESERVED IP rather than
# the ephemeral one a VNIC gets by default: an ephemeral address can be replaced
# when the instance is stopped and started, which would silently break both DNS
# and the issued certificate.
#
# Reserved public IPs are part of Always Free.
# ---------------------------------------------------------------------------

# The VNIC's own ephemeral IP has to be identified before it can be swapped out:
# an OCI VNIC accepts only one public IP at a time.
data "oci_core_vnic_attachments" "backend" {
  compartment_id = local.compartment_id
  instance_id    = oci_core_instance.backend.id
}

data "oci_core_private_ips" "backend" {
  vnic_id = data.oci_core_vnic_attachments.backend.vnic_attachments[0].vnic_id
}

# A VNIC accepts exactly one public IP at a time, and OCI rejects attaching a
# reserved one while an ephemeral address is still bound ("Private IP ... already
# has a public IP assigned to it"). The instance therefore launches with
# assign_public_ip = false when reserved addressing is on, leaving the VNIC free
# for the reserved IP created here — which then becomes its only public address.
resource "oci_core_public_ip" "backend" {
  count = var.use_reserved_ip ? 1 : 0

  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-reserved-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.backend.private_ips[0].id
  freeform_tags  = local.tags

  depends_on = [oci_core_instance.backend]
}

locals {
  # Everything downstream — outputs, the health URL, the CI host — reads this
  # rather than the instance attribute, so both modes resolve correctly.
  public_ip = (
    var.use_reserved_ip
    ? oci_core_public_ip.backend[0].ip_address
    : oci_core_instance.backend.public_ip
  )
}
