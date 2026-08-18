# Fallback sizing for when Ampere capacity cannot be obtained.
#
#   terraform apply -var-file=terraform.tfvars -var-file=x86.tfvars
#
# Everything else — credentials, domain, keys — still comes from
# terraform.tfvars; this file only overrides the compute shape. Applying it
# REPLACES the instance, but the VCN, the reserved IP and the OCIR repository
# are separate resources and survive, so the DNS record stays valid.
#
# Measured footprint of the stack on this shape: Nest ~98 MB under load, Redis
# ~33 MB, leaving roughly half of the 1 GB free after Ubuntu and Docker. It
# fits, but there is no headroom for building images on the box — which this
# setup never does, since GitHub Actions builds and the VM only pulls.
#
# After switching, set the BUILD_PLATFORM GitHub variable to linux/amd64
# (`terraform output image_platform`) or the container will not start.

instance_shape      = "VM.Standard.E2.1.Micro"
instance_ocpus      = 1
instance_memory_gbs = 1
