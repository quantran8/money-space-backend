# ---------------------------------------------------------------------------
# Fail fast, with a message that says what to do — rather than letting `file()`
# surface a generic "no file exists at ..." during the plan.
# ---------------------------------------------------------------------------

resource "terraform_data" "validate_inputs" {
  lifecycle {
    precondition {
      condition = var.ssh_public_key != "" || fileexists(local.ssh_public_key_resolved_path)
      error_message = join(" ", [
        "No SSH public key found at ${local.ssh_public_key_resolved_path}.",
        "Generate one with `ssh-keygen -t ed25519 -C money-space`, or point",
        "ssh_public_key_path at an existing key, or paste the key into the",
        "ssh_public_key variable.",
      ])
    }

    # A domain plus an ephemeral IP is the configuration that breaks quietly:
    # everything works until the instance is stopped, then the address changes,
    # the hand-made A record goes stale and the certificate stops renewing.
    precondition {
      condition = var.domain_name == "" || var.use_reserved_ip
      error_message = join(" ", [
        "domain_name is set but use_reserved_ip is false.",
        "An ephemeral IP can change when the instance is stopped and started,",
        "which would break the DNS record you maintain by hand at DPDNS and,",
        "with it, certificate renewal. Either set use_reserved_ip = true or",
        "clear domain_name to serve plain HTTP.",
      ])
    }

    precondition {
      condition     = var.acme_email == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.acme_email))
      error_message = "acme_email must be a valid e-mail address, or empty to register anonymously."
    }

    # E2.1.Micro is fixed at 1 OCPU / 1 GB. Passing sizing variables for it is
    # harmless (they are ignored), but silently getting a tenth of the memory
    # you asked for is not, so say so up front.
    precondition {
      condition = local.is_flex_shape || (var.instance_ocpus == 1 && var.instance_memory_gbs <= 1)
      error_message = join(" ", [
        "VM.Standard.E2.1.Micro is a fixed shape: 1 OCPU and 1 GB of memory.",
        "instance_ocpus/instance_memory_gbs cannot change that, so set them to",
        "1 and 1 to make the real size explicit, or use VM.Standard.A1.Flex.",
      ])
    }

    precondition {
      condition = !local.is_flex_shape || var.instance_memory_gbs <= var.instance_ocpus * 64
      error_message = join(" ", [
        "VM.Standard.A1.Flex allows at most 64 GB of memory per OCPU.",
        "Requested ${var.instance_memory_gbs} GB with ${var.instance_ocpus} OCPU(s).",
      ])
    }
  }
}
