# ---------------------------------------------------------------------------
# OCIR repository. GitHub Actions pushes the image here; the VM pulls from it.
# Included in Always Free.
# ---------------------------------------------------------------------------

data "oci_objectstorage_namespace" "tenancy" {
  compartment_id = var.tenancy_ocid
}

resource "oci_artifacts_container_repository" "backend" {
  count = var.create_container_repository ? 1 : 0

  compartment_id = local.compartment_id
  display_name   = var.container_repository_name
  is_public      = var.container_repository_is_public

  # OCIR has no retention policy — nothing here or on the Oracle side expires an
  # image, so every push accumulates until something removes it. That is what
  # .github/workflows/prune-registry.yml is for.
  readme {
    content = "Backend image for ${var.project_name}. Pushed by GitHub Actions, pulled by the OCI compute instance."
    format  = "TEXT_MARKDOWN"
  }
}
