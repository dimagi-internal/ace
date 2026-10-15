#!/usr/bin/env bash
# bake.sh: build the android-emulator image with Packer, then point the SSM
# parameter the stack's launch template resolves at it.
#
#   AWS_PROFILE=labs ./bake.sh                    # build + publish the AMI id
#   AWS_PROFILE=labs ./bake.sh --skip-build AMI   # publish an existing AMI id
#                                                 # (a retry, or a rollback)
#   ... --no-prune                                # keep every old image
#   ... --keep N                                  # images to keep (default 3)
#
# The parameter is /canopy/capabilities/<Owner>/<Capability>/ami (from
# stack.params.json). Leases launched after the write boot the new image;
# leases already running keep theirs (deregistering an AMI never touches a
# running instance). Nothing is ever re-pinned by id.
#
# Before the parameter is written the AMI must carry an `ace:states` tag equal
# to capability.yaml's params.state enum: an image that lacks a state the
# manifest offers would fail every lease for it with reason unknown-state.
#
# After a successful write, old images are pruned: the newest --keep (default
# 3) are kept, and so are the one the parameter now points at and the one it
# pointed at before (the rollback target). --no-prune skips this.
#
# Needs: packer >= 1.10 (the amazon plugin, pinned to 1.8.3, is installed by
# `packer init`), aws CLI v2, jq, git; the account's default VPC with a public
# subnet (Packer's bake host is reached over SSH from this machine). The bake
# host is an m8i.xlarge with nested virtualization, like a lease.
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

SKIP_BUILD_AMI=""
PRUNE=1
KEEP=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD_AMI="${2:?--skip-build needs an AMI id}"; shift 2 ;;
    --no-prune) PRUNE=""; shift ;;
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive number (got '$KEEP')"

load_config
need aws jq git
aws_auth

PREVIOUS="$(current_ami)"
[[ -n "$PREVIOUS" ]] && note "Current $AMI_PARAM = $PREVIOUS (roll back with: ./bake.sh --skip-build $PREVIOUS)"

if [[ -n "$SKIP_BUILD_AMI" ]]; then
  [[ "$SKIP_BUILD_AMI" =~ ^ami-[0-9a-f]{8,17}$ ]] || die "not an AMI id: $SKIP_BUILD_AMI"
  AMI_ID="$SKIP_BUILD_AMI"
else
  need packer
  SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- "$CAP_DIR/image")" ]]; then
    warn "image/ has uncommitted changes; the AMI's ace-sha tag ($SHA) will not describe it exactly"
    SHA="$SHA-dirty"
  fi
  cd "$CAP_DIR/image"
  rm -f packer-manifest.json
  note "packer init"
  packer init .
  packer validate -var "ace_git_sha=$SHA" -var "region=$REGION" .
  note "packer build"
  packer build -color=false -var "ace_git_sha=$SHA" -var "region=$REGION" .
  AMI_ID="$(jq -er '.last_run_uuid as $u | .builds[] | select(.packer_run_uuid == $u) | .artifact_id' packer-manifest.json \
    | tr ',' '\n' | awk -F: -v r="$REGION" '$1 == r {print $2; exit}')"
  [[ "$AMI_ID" =~ ^ami-[0-9a-f]{8,17}$ ]] || die "could not read the AMI id from image/packer-manifest.json"
  note "Built $AMI_ID"
fi

aws ec2 wait image-available --region "$REGION" --image-ids "$AMI_ID"
STATE="$(aws ec2 describe-images --region "$REGION" --image-ids "$AMI_ID" --query 'Images[0].State' --output text)"
[[ "$STATE" == available ]] || die "$AMI_ID is $STATE, not available"
require_ami_states "$AMI_ID"

# --data-type aws:ec2:image makes SSM verify the id is a real, visible AMI, and
# is what lets an EC2 launch template resolve the parameter as its ImageId.
aws ssm put-parameter --region "$REGION" --name "$AMI_PARAM" --type String \
  --data-type aws:ec2:image --value "$AMI_ID" --overwrite \
  --description "ACE android-emulator capability image (bake.sh)" >/dev/null
note "$AMI_PARAM = $AMI_ID"

if [[ -n "$PRUNE" ]]; then
  prune_images "$KEEP" "$AMI_ID" ${PREVIOUS:+"$PREVIOUS"}
else
  note "Not pruning old images (--no-prune). Later: ./teardown.sh --yes --images-only"
fi
note "New leases boot this image. If the stack does not exist yet: ./deploy.sh"
