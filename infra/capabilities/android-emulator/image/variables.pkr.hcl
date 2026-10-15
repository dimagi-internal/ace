variable "region" {
  type    = string
  default = "us-east-1"
}

variable "source_ami_name" {
  description = <<-EOT
    EXACT name of the Ubuntu 24.04 (noble) source AMI, owned by
    var.source_ami_owner. Pinned, never a wildcard: a wildcard with
    most_recent = true bakes whatever Canonical published that morning, so
    two bakes of one commit could differ. Bump it deliberately; to find the
    current one:

      aws ec2 describe-images --region us-east-1 --owners 099720109477 \
        --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
        --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text

    The serial (20261004) is the newest noble amd64 gp3 build Canonical
    published to us-east-1 as of 2026-10-14: ami-0fa5967347d08d2df there
    (looked up with the command above).
    The resolved id and name are tagged on the AMI (source-ami,
    source-ami-name).
  EOT
  type        = string
  default     = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261004"
}

variable "source_ami_owner" {
  description = "Canonical's AWS account ID."
  type        = string
  default     = "099720109477"
}

variable "source_ami_id" {
  description = "Optional: an explicit source AMI id. When set it wins over source_ami_name (which is still looked up, so it must exist). Empty = resolve source_ami_name."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = <<-EOT
    Instance type for the BAKE host. The same family as the runtime machine
    (the stack's InstanceType, m8i.xlarge), launched with nested
    virtualization (enable_nested_virtualization, packer-plugin-amazon
    >= 1.8.3, which validates the family: C7i/M7i/R7i/I7i/C8i/M8i/R8i/X8i).

    Until plugin v1.8.3 (2026-10-07) the amazon-ebs builder could not request
    nested virtualization, so the bake ran on c5n.metal (~$3.9/h, 12-15 min
    just to stop). /dev/kvm on the bake host is now a nice-to-have: the bake
    never boots the emulator, and 00-base.sh only reports kvm-ok.
  EOT
  type        = string
  default     = "m8i.xlarge"
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
    match this list exactly (test/infra/android-emulator-capability.test.ts),
    and every version needs a pinned URL + sha256 in scripts/40-commcare-apk.sh.

    2.63.0 is deliberately absent: it is the crash-loop build (ace#938).
  EOT
  type        = list(string)
  default     = ["2.64.0", "2.62.0"]
}
