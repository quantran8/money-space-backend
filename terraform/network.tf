# ---------------------------------------------------------------------------
# VCN with a single public regional subnet. One VM, one subnet — a private
# subnet plus NAT gateway would add cost (NAT is not in the Always Free tier)
# without buying anything here.
# ---------------------------------------------------------------------------

resource "oci_core_vcn" "main" {
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = local.dns_label
  freeform_tags  = local.tags
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.project_name}-igw"
  enabled        = true
  freeform_tags  = local.tags
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.project_name}-public-rt"
  freeform_tags  = local.tags

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.project_name}-public-sl"
  freeform_tags  = local.tags

  # Outbound: unrestricted, so the VM can reach Supabase, GitHub and the
  # Ubuntu/Docker package mirrors.
  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }

  ingress_security_rules {
    description = "SSH"
    source      = var.ssh_source_cidr
    source_type = "CIDR_BLOCK"
    protocol    = local.protocol_tcp

    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    description = "HTTP — also serves Let's Encrypt HTTP-01 challenges"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = local.protocol_tcp

    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    description = "HTTPS"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = local.protocol_tcp

    tcp_options {
      min = 443
      max = 443
    }
  }

  # Direct access to the Nest port, bypassing Caddy. Handy before a domain is
  # pointed here; disable with expose_app_port = false once TLS is live.
  dynamic "ingress_security_rules" {
    for_each = var.expose_app_port ? [1] : []

    content {
      description = "Nest app (direct, no TLS)"
      source      = "0.0.0.0/0"
      source_type = "CIDR_BLOCK"
      protocol    = local.protocol_tcp

      tcp_options {
        min = var.app_port
        max = var.app_port
      }
    }
  }

  # Path-MTU discovery and ping.
  ingress_security_rules {
    description = "ICMP path MTU discovery"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = local.protocol_icmp

    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  display_name               = "${var.project_name}-public-subnet"
  cidr_block                 = "10.0.1.0/24"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
  freeform_tags              = local.tags
}
