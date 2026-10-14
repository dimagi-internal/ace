# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables set here are read by the scripts that source it
# Shared by deploy.sh, bake.sh and teardown.sh. Sourced, never run.
#
# Everything the three scripts agree on is read from ONE place: the stack's
# name, region, owner and capability come from stack.params.json, and the
# capability name is cross-checked against capability.yaml, so a rename cannot
# leave one script pointing at the old stack.

CAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CAP_DIR/../../.." && pwd)"
PARAMS_FILE="$CAP_DIR/stack.params.json"
MANIFEST_FILE="$CAP_DIR/capability.yaml"

export AWS_PROFILE="${AWS_PROFILE:-labs}"
export AWS_PAGER=""

note() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
  done
}

param() { jq -er --arg k "$1" '.parameters[$k]' "$PARAMS_FILE"; }

load_config() {
  need jq
  [[ -f "$PARAMS_FILE" ]] || die "no $PARAMS_FILE"
  STACK_NAME="$(jq -er .stack_name "$PARAMS_FILE")"
  REGION="$(jq -er .region "$PARAMS_FILE")"
  OWNER="$(param Owner)"
  CAPABILITY="$(param Capability)"
  AMI_PARAM="/canopy/capabilities/${OWNER}/${CAPABILITY}/ami"
  local manifest_name manifest_stack manifest_region
  manifest_name="$(awk '/^name:/ {print $2; exit}' "$MANIFEST_FILE")"
  manifest_stack="$(awk '/^  stack:/ {print $2; exit}' "$MANIFEST_FILE")"
  manifest_region="$(awk '/^  region:/ {print $2; exit}' "$MANIFEST_FILE")"
  [[ "$manifest_name" == "$CAPABILITY" ]] || die "capability.yaml name '$manifest_name' != stack.params.json Capability '$CAPABILITY'"
  [[ "$manifest_stack" == "$STACK_NAME" ]] || die "capability.yaml aws.stack '$manifest_stack' != stack.params.json stack_name '$STACK_NAME'"
  [[ "$manifest_region" == "$REGION" ]] || die "capability.yaml aws.region '$manifest_region' != stack.params.json region '$REGION'"
}

aws_auth() {
  need aws
  local who
  who="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" \
    || die "AWS auth failed for profile '$AWS_PROFILE' (aws sso login --profile $AWS_PROFILE)"
  note "AWS identity: $who (profile $AWS_PROFILE, region $REGION)"
}

stack_status() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NONE"
}

stack_output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null
}
