#!/usr/bin/env bash
# deploy.sh: create or update ACE's android-emulator stack, then publish the
# capability to canopy-web.
#
#   AWS_PROFILE=labs ./deploy.sh                 # stack + publish
#   ./deploy.sh --skip-publish                   # stack only
#   ./deploy.sh --template-file <path>           # use a local template instead
#                                                # of the pinned tag (testing
#                                                # an unreleased canopy change)
#
# Idempotent: `aws cloudformation deploy --no-fail-on-empty-changeset` is a
# no-op on an unchanged stack, and publish-capabilities is an idempotent PUT.
#
# Order of checks, each fatal and each before anything is written:
#   1. the pinned canopy template exists at stack.params.json's tag;
#   2. every key in stack.params.json is a parameter that template declares,
#      and every parameter it requires (no default) is given;
#   3. the AMI parameter bake.sh writes already exists (a launch template that
#      resolves a missing parameter cannot launch anything).
# Then the deploy, then a check that the stack exposes the contract's outputs.
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

SKIP_PUBLISH=""
TEMPLATE_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-publish) SKIP_PUBLISH=1; shift ;;
    --template-file) TEMPLATE_OVERRIDE="${2:?--template-file needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_config
need aws jq
aws_auth

WORK="$(mktemp -d -t ace-cap-deploy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
TEMPLATE="$WORK/template.yaml"

# ── 1. The pinned template ─────────────────────────────────────────────────
T_REPO="$(jq -er .template.repo "$PARAMS_FILE")"
T_REF="$(jq -er .template.ref "$PARAMS_FILE")"
T_PATH="$(jq -er .template.path "$PARAMS_FILE")"
if [[ -n "$TEMPLATE_OVERRIDE" ]]; then
  warn "using local template $TEMPLATE_OVERRIDE, NOT the pinned $T_REPO@$T_REF"
  cp "$TEMPLATE_OVERRIDE" "$TEMPLATE"
else
  need gh
  note "Fetching $T_PATH from $T_REPO@$T_REF"
  gh api -H "Accept: application/vnd.github.raw+json" \
    "repos/$T_REPO/contents/$T_PATH?ref=$T_REF" >"$TEMPLATE" \
    || die "could not fetch $T_PATH at $T_REF from $T_REPO. Is the tag released? (gh release list -R $T_REPO)"
fi

# ── 2. Parameters agree with the template ──────────────────────────────────
DECLARED="$WORK/declared.json"
aws cloudformation validate-template --region "$REGION" --template-body "file://$TEMPLATE" \
  --query 'Parameters[].{key:ParameterKey,default:DefaultValue}' --output json >"$DECLARED"

UNKNOWN="$(jq -r --slurpfile d "$DECLARED" \
  '.parameters | keys[] | select(. as $k | ($d[0] | map(.key) | index($k)) | not)' "$PARAMS_FILE")"
[[ -z "$UNKNOWN" ]] || die "stack.params.json sets parameters the template at $T_REF does not declare: $(echo "$UNKNOWN" | tr '\n' ' ')"

MISSING="$(jq -r --slurpfile p "$PARAMS_FILE" \
  '.[] | select(.default == null) | .key | select(. as $k | ($p[0].parameters | has($k)) | not)' "$DECLARED")"
[[ -z "$MISSING" ]] || die "the template requires parameters stack.params.json does not set: $(echo "$MISSING" | tr '\n' ' ')"
note "Parameters match the template ($(jq length "$DECLARED") declared)"

# ── Network: an empty VpcId/SubnetId means the account's default VPC ────────
VPC_ID="$(param VpcId || true)"
SUBNET_ID="$(param SubnetId || true)"
INSTANCE_TYPE="$(param InstanceType)"
if [[ -z "$VPC_ID" ]]; then
  VPC_ID="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true \
    --query 'Vpcs[0].VpcId' --output text)"
  [[ "$VPC_ID" == vpc-* ]] || die "no default VPC in $REGION; set VpcId and SubnetId in stack.params.json"
  note "VpcId (default VPC): $VPC_ID"
fi
if [[ -z "$SUBNET_ID" ]]; then
  OFFERED="$(aws ec2 describe-instance-type-offerings --region "$REGION" --location-type availability-zone \
    --filters "Name=instance-type,Values=$INSTANCE_TYPE" --query 'InstanceTypeOfferings[].Location' --output text \
    | tr '\t' '\n')"
  [[ -n "$OFFERED" ]] || die "$INSTANCE_TYPE is not offered in any AZ of $REGION"
  while read -r sid az; do
    if grep -Fxq "$az" <<<"$OFFERED"; then SUBNET_ID="$sid"; break; fi
  done < <(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" Name=default-for-az,Values=true \
    --query 'sort_by(Subnets,&AvailabilityZone)[].[SubnetId,AvailabilityZone]' --output text)
  [[ "$SUBNET_ID" == subnet-* ]] || die "no default subnet in $VPC_ID whose AZ offers $INSTANCE_TYPE; set SubnetId"
  note "SubnetId (first default subnet offering $INSTANCE_TYPE): $SUBNET_ID"
fi

# ── 3. The image pointer exists ────────────────────────────────────────────
AMI_ID="$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" \
  --query Parameter.Value --output text 2>/dev/null || true)"
[[ "$AMI_ID" == ami-* ]] || die "SSM parameter $AMI_PARAM is not set. Bake the image first: ./bake.sh"
note "Image: $AMI_PARAM = $AMI_ID"

# ── Deploy ─────────────────────────────────────────────────────────────────
OVERRIDES=()
while IFS= read -r kv; do OVERRIDES+=("$kv"); done < <(
  jq -r --arg vpc "$VPC_ID" --arg subnet "$SUBNET_ID" \
    '.parameters | .VpcId = $vpc | .SubnetId = $subnet | to_entries[] | "\(.key)=\(.value)"' "$PARAMS_FILE"
)
note "Deploying $STACK_NAME ($(stack_status))"
aws cloudformation deploy --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${OVERRIDES[@]}" \
  --tags agent="$OWNER" capability="$CAPABILITY" managed-by=ace-capability-deploy canopy-template="$T_REF"

# ── The contract's outputs (spec §2) ───────────────────────────────────────
for out in LaunchTemplateId ArtifactsBucketName InstanceRoleArn Capability; do
  v="$(stack_output "$out")"
  [[ -n "$v" && "$v" != "None" ]] || die "stack $STACK_NAME has no output $out: the template at $T_REF does not implement the ec2-ephemeral contract"
  note "  $out = $v"
done
[[ "$(stack_output Capability)" == "$CAPABILITY" ]] || die "stack output Capability != $CAPABILITY"

# ── Publish to canopy-web ──────────────────────────────────────────────────
PUBLISH=(canopy-runtime publish-capabilities --spec "$REPO_ROOT/runtime.yaml" --agent "$OWNER")
if [[ -n "$SKIP_PUBLISH" ]]; then
  note "Skipping publish. To publish: ${PUBLISH[*]}"
  exit 0
fi
if ! command -v canopy-runtime >/dev/null 2>&1; then
  cat >&2 <<EOF
ERROR: the stack is deployed, but canopy-runtime is not installed, so the
capability is NOT published. Install it from the same canopy tag and re-run
(the deploy step is a no-op the second time):

  pip install "canopy-runtime @ git+https://github.com/$T_REPO@$T_REF#subdirectory=packages/canopy_runtime"
  ${PUBLISH[*]}

publish-capabilities authenticates as an admin of agent '$OWNER' on canopy-web.
EOF
  exit 3
fi
note "Publishing: ${PUBLISH[*]}"
"${PUBLISH[@]}"
note "Done. Next: a workspace admin grants '$OWNER' the '$CAPABILITY' capability on canopy-web (README § Grant)."
