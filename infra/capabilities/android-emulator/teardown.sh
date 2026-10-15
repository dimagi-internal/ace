#!/usr/bin/env bash
# teardown.sh: remove ACE's android-emulator capability from the account.
#
#   AWS_PROFILE=labs ./teardown.sh --yes                  # machines + stack + bucket
#   AWS_PROFILE=labs ./teardown.sh --yes --images         # ...and every baked AMI,
#                                                         # its snapshots, and the
#                                                         # SSM AMI parameter
#   AWS_PROFILE=labs ./teardown.sh --yes --images-only    # prune images, keep the
#                                                         # stack: keeps the newest
#                                                         # --keep N (default 3) and
#                                                         # the AMI the parameter
#                                                         # points at
#
# Idempotent: every step skips what is already gone, so a partial run can be
# re-run. Order matters and is fixed:
#   1. terminate every instance tagged canopy:capability=<cap>, canopy:owner=<agent>
#      (live leases die here; retire the capability on canopy-web first, below);
#   2. empty the artifacts bucket (CloudFormation cannot delete a non-empty one);
#   3. delete the stack, then delete the bucket if the template retained it;
#   4. with --images: deregister the baked AMIs and delete their snapshots.
# Image deletion only ever touches ids shaped ami-/snap-, and refuses to run
# when it cannot tell which AMI the parameter points at (an unreadable
# parameter is never read as "none").
#
# Do this FIRST, so canopy-web stops leasing: remove the capability from
# runtime.yaml `capabilities:` and run
#   canopy-runtime publish-capabilities --spec runtime.yaml --agent ace
# (a capability missing from the list is retired and its live leases released).
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

YES="" IMAGES="" IMAGES_ONLY="" KEEP=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --images) IMAGES=1; shift ;;
    --images-only) IMAGES=1; IMAGES_ONLY=1; shift ;;
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$YES" ]] || die "refusing to run without --yes (this terminates machines and deletes the stack)"
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep must be a number (got '$KEEP')"

load_config
need aws jq
aws_auth

# prune_images (in _common.sh) keeps the newest N and any pinned id.
CURRENT_AMI="$(current_ami)"

if [[ -n "$IMAGES_ONLY" ]]; then
  prune_images "$KEEP" ${CURRENT_AMI:+"$CURRENT_AMI"}
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
  prune_images 0
  aws ssm delete-parameter --region "$REGION" --name "$AMI_PARAM" 2>/dev/null || true
fi
note "Teardown complete."
