# The image for ACE's android-emulator capability. Moved from ace-web
# infra/mobile-ami/ace-mobile.pkr.hcl and adapted to the ec2-ephemeral contract
# (canopy-web docs/superpowers/specs/2026-10-14-cloud-capabilities-design.md §2):
# a boot hook that reads the lease's user-data, arms the max-lifetime halt,
# cold-boots the AVD for params.state and writes ready.json; the ace-mobile CLI
# on PATH; an in-VM idle backstop; nothing ace-web-specific.
#
# Built by ../bake.sh, which also writes the resulting AMI id to the SSM
# parameter the stack's launch template resolves. Run that, not this directly.
packer {
  required_version = ">= 1.10"

  required_plugins {
    amazon = {
      source = "github.com/hashicorp/amazon"
      # Exact pin. 1.8.3 is the first release whose amazon-ebs builder can
      # request nested virtualization (`enable_nested_virtualization`,
      # hashicorp/packer-plugin-amazon#679); a floating constraint would let a
      # later release change the bake under an unchanged commit.
      version = "= 1.8.3"
    }
  }
}

locals {
  ami_name = "${var.ami_name_prefix}-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"
  # The states this image bakes, as capability.yaml names them. Tagged on the
  # AMI as `ace:states` (comma-separated, in bake order) so bake.sh and
  # deploy.sh can refuse to point the stack at, or publish a manifest over, an
  # image that lacks a state the manifest offers.
  states = join(",", [for v in var.commcare_versions : "cc-${v}"])
  # Tag keys deliberately avoid the `canopy:` prefix. canopy-web's sweep
  # terminates every INSTANCE tagged `canopy:capability` that has no live lease;
  # the bake host carries these tags too, and a sweep must never kill a bake.
  common_tags = {
    agent      = "ace"
    capability = "android-emulator"
    component  = "capability-image"
    managed-by = "packer"
    ace-sha    = var.ace_git_sha
  }
}

data "amazon-ami" "ubuntu_noble" {
  filters = {
    name                = var.source_ami_name
    root-device-type    = "ebs"
    virtualization-type = "hvm"
    architecture        = "x86_64"
  }
  # The name is exact, so this matches one image; most_recent only breaks a tie
  # Canonical never creates.
  most_recent = true
  owners      = [var.source_ami_owner]
  region      = var.region
}

source "amazon-ebs" "ace_mobile" {
  region        = var.region
  source_ami    = var.source_ami_id != "" ? var.source_ami_id : data.amazon-ami.ubuntu_noble.id
  instance_type = var.instance_type
  ssh_username  = "ubuntu"

  # Same machine shape as a lease: KVM on the bake host, so a broken nested-virt
  # family shows up in 00-base.sh's kvm-ok line rather than at the first lease.
  enable_nested_virtualization = true

  # Packer's temporary security group opens SSH for the provisioners. Scope it
  # to the baker's own public IP instead of the default 0.0.0.0/0.
  temporary_security_group_source_public_ip = true

  # Generous waiter: an EBS snapshot of a 30 GB root can take longer than the
  # default 10 minutes, and timing out AFTER provisioning discards the work.
  # 30s x 60 = 30 min.
  aws_polling {
    delay_seconds = 30
    max_attempts  = 60
  }

  # Headroom for the SDK, the system image and the APKs. The AMI's block-device
  # mapping inherits this size; the stack's RootVolumeGb must be >= it.
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  ami_name        = local.ami_name
  ami_description = "ACE android-emulator capability (Android 34 / Pixel 7 AVD, Maestro 2.5.1, states ${local.states}, ace ${var.ace_git_sha})."

  tags = merge(local.common_tags, {
    Name            = local.ami_name
    base-os         = "ubuntu-24.04"
    "ace:states"    = local.states
    source-ami      = "{{ .SourceAMI }}"
    source-ami-name = "{{ .SourceAMIName }}"
  })
  run_tags        = merge(local.common_tags, { Name = "${local.ami_name}-bake" })
  run_volume_tags = merge(local.common_tags, { Name = "${local.ami_name}-bake-root" })
}

build {
  name = "ace-mobile"

  sources = ["source.amazon-ebs.ace_mobile"]

  # Stage everything the scripts read FIRST: 00-base.sh verifies the AWS CLI
  # against keys/aws-cli-team.asc, and 60-systemd.sh installs files/ and the
  # CLI. Copying files starts nothing. The trailing slash copies a directory's
  # contents (Packer's file-provisioner rule).
  provisioner "shell" {
    inline = ["mkdir -p /tmp/ace-files /tmp/ace-cli /tmp/ace-keys"]
  }

  provisioner "file" {
    source      = "files/"
    destination = "/tmp/ace-files"
  }

  provisioner "file" {
    source      = "keys/"
    destination = "/tmp/ace-keys"
  }

  provisioner "file" {
    source      = "cli/ace_mobile.py"
    destination = "/tmp/ace-cli/ace_mobile.py"
  }

  # 00 — base packages + JDK + pinned/verified awscli; no apt upgrade; apt and
  # snap background updates off.
  provisioner "shell" {
    script          = "scripts/00-base.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # 10 — Android SDK cmdline-tools (pinned + sha256), platform-tools, emulator,
  # build-tools (aapt, apksigner), system image.
  provisioner "shell" {
    script          = "scripts/10-android-sdk.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # 20 — the ACE_Pixel_API_34 AVD (same name as the laptop path).
  provisioner "shell" {
    script          = "scripts/20-avd.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # 30 — Maestro CLI to /opt/maestro (pinned + sha256).
  provisioner "shell" {
    script          = "scripts/30-maestro.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # 40 — CommCare APKs, one per state, to /opt/ace/apks/<ver>/ (pinned URL +
  # sha256 + Dimagi signing certificate).
  provisioner "shell" {
    script          = "scripts/40-commcare-apk.sh"
    execute_command = "{{ .Vars }} sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "COMMCARE_VERSIONS=${join(",", var.commcare_versions)}",
    ]
  }

  # 50 — /opt/ace/states.yaml. No emulator boot here: every lease cold-boots.
  provisioner "shell" {
    script          = "scripts/50-states.sh"
    execute_command = "{{ .Vars }} sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "COMMCARE_VERSIONS=${join(",", var.commcare_versions)}",
    ]
  }

  # 60 — boot hook, runner, idle watchdog, the ace-mobile CLI; then
  # `systemd-analyze verify`. Last, so nothing starts during provisioning.
  provisioner "shell" {
    script          = "scripts/60-systemd.sh"
    execute_command = "{{ .Vars }} sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "ACE_GIT_SHA=${var.ace_git_sha}",
    ]
  }

  # bake.sh reads the AMI id from this manifest rather than scraping logs.
  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
  }
}
