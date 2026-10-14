variable "region" {
  type    = string
  default = "us-east-1"
}

variable "source_ami_filter_name" {
  description = "Name pattern for the Ubuntu 24.04 (noble) source AMI."
  type        = string
  # Canonical's official AMI naming convention.
  default = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
}

variable "source_ami_owner" {
  description = "Canonical's AWS account ID."
  type        = string
  default     = "099720109477"
}

variable "instance_type" {
  description = <<-EOT
    Instance type for the BAKE host (not the runtime machine; that is the
    stack's InstanceType, m8i.xlarge with nested virtualization).

    c5n.metal, as in ace-web: bare metal always exposes KVM, and 00-base.sh
    runs `kvm-ok`. The cheaper m8i.xlarge-with-nested-virtualization is not an
    option because Packer's amazon-ebs builder cannot request it: plugin
    v1.8.0 exposes no cpu_options / nested-virtualization setting and cannot
    launch from a launch template (checked 2026-10-14). The runtime gets nested
    virtualization from the launch template instead.
  EOT
  type        = string
  default     = "c5n.metal"
}

variable "ami_name_prefix" {
  type    = string
  default = "ace-android-emulator"
}

variable "ace_git_sha" {
  description = "ACE commit the image is built from (bake.sh passes `git rev-parse HEAD`). Tagged on the AMI and written to /opt/ace/MANIFEST.txt."
  type        = string
  default     = "unknown"
}

variable "commcare_versions" {
  description = <<-EOT
    Ordered CommCare APK versions to bake. Each becomes a state `cc-<version>`
    in /opt/ace/states.yaml; the FIRST is the default a lease boots when it
    passes no params.state. capability.yaml's params.state enum and default must
    match this list exactly (test/infra/android-emulator-capability.test.ts).
  EOT
  type        = list(string)
  default     = ["2.63.0", "2.62.0"]
}
