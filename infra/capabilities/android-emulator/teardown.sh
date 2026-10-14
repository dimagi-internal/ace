#!/usr/bin/env bash
# teardown.sh: remove ACE's android-emulator capability from the account.
#
#   AWS_PROFILE=labs ./teardown.sh --yes                  # machines + stack + bucket
#   AWS_PROFILE=labs ./teardown.sh --yes --images         # ...and every baked AMI,
#                                                         # its snapshots, and the
#                                                         # SSM AMI parameter
#   AWS_PROFILE=labs ./teardown.sh --yes --images-only    # prune images, keep the
#                                                         # stack (keeps the AMI the
#                                                         # parameter points at)
#
# Idempotent: every step skips what is already gone, so a partial run can be
# re-run. Order matters and is fixed:
#   1. terminate every instance tagged canopy:capability=<cap>, canopy:owner=<agent>
#      (live leases die here; retire the capability on canopy-web first, below);
#   2. empty the artifacts bucket (CloudFormation cannot delete a non-empty one);
#   3. delete the stack, then delete the bucket if the template retained it;
#   4. with --images: deregister the baked AMIs and delete their snapshots.
#
# Do this FIRST, so canopy-web stops leasing: remove the capability from
# runtime.yaml `capabilities:` and run
#   canopy-runtime publish-capabilities --spec runtime.yaml --agent ace
# (a capability missing from the list is retired and its live leases released).
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

YES="" IMAGES="" IMAGES_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --images) IMAGES=1; shift ;;
    --images-only) IMAGES=1; IMAGES_ONLY=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$YES" ]] || die "refusing to run without --yes (this terminates machines and deletes the stack)"

load_config
need aws jq
aws_auth

prune_images() {
  local keep="$1" ami snaps snap
  while read -r ami; do
    [[ -n "$ami" && "$ami" != None ]] || continue
    if [[ "$ami" == "$keep" ]]; then note "  keeping $ami (the SSM parameter points at it)"; continue; fi
    snaps="$(aws ec2 describe-images --region "$REGION" --image-ids "$ami" \
      --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)"
    note "  deregistering $ami"
    aws ec2 deregister-image --region "$REGION" --image-id "$ami"
    for snap in $snaps; do
      [[ "$snap" == snap-* ]] || continue
      aws ec2 delete-snapshot --region "$REGION" --snapshot-id "$snap" || warn "could not delete $snap"
    done
  done < <(aws ec2 describe-images --region "$REGION" --owners self \
    --filters "Name=tag:agent,Values=$OWNER" "Name=tag:capability,Values=$CAPABILITY" \
    --query 'Images[].ImageId' --output text | tr '\t' '\n')
}

CURRENT_AMI="$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" \
  --query Parameter.Value --output text 2>/dev/null || true)"

if [[ -n "$IMAGES_ONLY" ]]; then
  note "Pruning images for $OWNER/$CAPABILITY"
  prune_images "$CURRENT_AMI"
  exit 0
fi

# ── 1. Machines ────────────────────────────────────────────────────────────
IDS="$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:canopy:capability,Values=$CAPABILITY" "Name=tag:canopy:owner,Values=$OWNER" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [[ -n "$IDS" ]]; then
  note "Terminating: $IDS"
  # shellcheck disable=SC2086  # word-splitting the id list is intended
  aws ec2 terminate-instances --region "$REGION" --instance-ids $IDS >/dev/null
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids $IDS
else
  note "No live $OWNER/$CAPABILITY machines"
fi

# ── 2-3. Bucket + stack ────────────────────────────────────────────────────
STATUS="$(stack_status)"
BUCKET=""
if [[ "$STATUS" != NONE ]]; then
  BUCKET="$(stack_output ArtifactsBucketName)"
  [[ "$BUCKET" == None ]] && BUCKET=""
fi
empty_bucket() {
  local b="$1" batch
  aws s3api head-bucket --bucket "$b" 2>/dev/null || return 0
  note "Emptying s3://$b"
  aws s3 rm "s3://$b" --recursive --only-show-errors
  # A versioned bucket keeps old versions and delete markers after `s3 rm`.
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$b" --max-items 1000 --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}')"
    [[ "$(jq '.Objects | length' <<<"$batch")" -gt 0 ]] || break
    aws s3api delete-objects --bucket "$b" --delete "$batch" >/dev/null
  done
}
if [[ -n "$BUCKET" ]]; then empty_bucket "$BUCKET"; fi

if [[ "$STATUS" != NONE ]]; then
  note "Deleting stack $STACK_NAME ($STATUS)"
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK_NAME"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK_NAME"
else
  note "Stack $STACK_NAME does not exist"
fi
if [[ -n "$BUCKET" ]] && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  note "Bucket $BUCKET was retained by the template; deleting it"
  empty_bucket "$BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
fi

# ── 4. Images ──────────────────────────────────────────────────────────────
if [[ -n "$IMAGES" ]]; then
  note "Deleting every image for $OWNER/$CAPABILITY and $AMI_PARAM"
  prune_images ""
  aws ssm delete-parameter --region "$REGION" --name "$AMI_PARAM" 2>/dev/null || true
fi
note "Teardown complete."
