#!/usr/bin/env bash
# bake.sh: build the android-emulator image with Packer, then point the SSM
# parameter the stack's launch template resolves at it.
#
#   AWS_PROFILE=labs ./bake.sh                    # build + publish the AMI id
#   AWS_PROFILE=labs ./bake.sh --skip-build AMI   # publish an existing AMI id
#                                                 # (a retry, or a rollback)
#
# The parameter is /canopy/capabilities/<Owner>/<Capability>/ami (from
# stack.params.json). Leases launched after the write boot the new image;
# leases already running keep theirs. Nothing is ever re-pinned by id.
#
# Idempotent in its effect: re-running bakes a NEW image (Packer cannot do
# otherwise) and points the parameter at it; --skip-build only rewrites the
# parameter. Old images are kept for rollback; prune them with
# `./teardown.sh --images-only --yes` when you no longer want them.
#
# Needs: packer >= 1.10 (the amazon plugin is installed by `packer init`), aws
# CLI v2, jq, git; the account's default VPC with a public subnet (Packer's
# bake host is reached over SSH from this machine). Takes ~25-40 min, almost all
# of it on a c5n.metal bake host (see image/variables.pkr.hcl for why metal).
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

SKIP_BUILD_AMI=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD_AMI="${2:?--skip-build needs an AMI id}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_config
need aws jq git
aws_auth

PREVIOUS="$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" \
  --query Parameter.Value --output text 2>/dev/null || true)"
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
  note "packer build (~25-40 min)"
  packer build -color=false -var "ace_git_sha=$SHA" -var "region=$REGION" .
  AMI_ID="$(jq -er '.last_run_uuid as $u | .builds[] | select(.packer_run_uuid == $u) | .artifact_id' packer-manifest.json \
    | tr ',' '\n' | awk -F: -v r="$REGION" '$1 == r {print $2; exit}')"
  [[ "$AMI_ID" == ami-* ]] || die "could not read the AMI id from image/packer-manifest.json"
  note "Built $AMI_ID"
fi

aws ec2 wait image-available --region "$REGION" --image-ids "$AMI_ID"
STATE="$(aws ec2 describe-images --region "$REGION" --image-ids "$AMI_ID" --query 'Images[0].State' --output text)"
[[ "$STATE" == available ]] || die "$AMI_ID is $STATE, not available"

# --data-type aws:ec2:image makes SSM verify the id is a real, visible AMI, and
# is what lets an EC2 launch template resolve the parameter as its ImageId.
aws ssm put-parameter --region "$REGION" --name "$AMI_PARAM" --type String \
  --data-type aws:ec2:image --value "$AMI_ID" --overwrite \
  --description "ACE android-emulator capability image (bake.sh)" >/dev/null
note "$AMI_PARAM = $AMI_ID"
note "New leases boot this image. If the stack does not exist yet: ./deploy.sh"
