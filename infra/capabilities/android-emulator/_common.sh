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

# ── States: capability.yaml ↔ the AMI's `ace:states` tag ───────────────────
# capability.yaml's params.state enum, sorted, comma-joined ("cc-2.62.0,cc-2.64.0").
manifest_states() {
  sed -n 's/^ *state: *{.*enum: *\[\([^]]*\)\].*/\1/p' "$MANIFEST_FILE" \
    | tr ',' '\n' | tr -d ' ' | sed '/^$/d' | sort | paste -sd, -
}

# An AMI's `ace:states` tag (bake order), or empty when the AMI has none.
ami_states() {
  aws ec2 describe-images --region "$REGION" --image-ids "$1" \
    --query "Images[0].Tags[?Key=='ace:states'].Value | [0]" --output text 2>/dev/null \
    | sed 's/^None$//'
}

# Refuse an AMI that does not bake exactly the states capability.yaml offers.
# A state the manifest offers and the image lacks passes canopy-web's
# validation and then fails minutes into a lease (ready.json unknown-state).
require_ami_states() {
  local ami="$1" have want
  want="$(manifest_states)"
  [[ -n "$want" ]] || die "could not read params.state.enum from $MANIFEST_FILE"
  have="$(ami_states "$ami" | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
  [[ -n "$have" ]] || die "$ami has no ace:states tag (baked before the tag existed?); it cannot be checked against capability.yaml ($want). Rebake: ./bake.sh"
  [[ "$have" == "$want" ]] || die "$ami bakes states [$have] but capability.yaml offers [$want]. Make image/variables.pkr.hcl commcare_versions and capability.yaml agree, then rebake."
  note "$ami bakes exactly the manifest's states: $have"
}

# The SSM AMI parameter's value; empty ONLY when the parameter does not exist.
# Any other failure (auth, throttling, network) is fatal: callers prune images
# relative to this value, and "unknown" must never read as "none".
current_ami() {
  local out err
  err="$(mktemp)"
  if out="$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" \
      --query Parameter.Value --output text 2>"$err")"; then
    rm -f "$err"
    [[ "$out" =~ ^ami-[0-9a-f]{8,17}$ ]] || die "$AMI_PARAM holds '$out', not an AMI id"
    printf '%s\n' "$out"
    return 0
  fi
  if grep -q ParameterNotFound "$err"; then rm -f "$err"; return 0; fi
  local msg; msg="$(cat "$err")"; rm -f "$err"
  die "could not read $AMI_PARAM: $msg"
}

# ── Image pruning, shared by bake.sh (after a bake) and teardown.sh ─────────
# prune_images KEEP_NEWEST [KEEP_ID...]
# Deregisters every image tagged agent=<OWNER>, capability=<CAPABILITY> except
# the KEEP_NEWEST most recently created and every KEEP_ID, and deletes their
# snapshots. Only ever touches ids that look like ami-/snap- ids; a KEEP_ID that
# does not look like an AMI id aborts before anything is deleted.
prune_images() {
  local keep_n="$1"; shift
  local keep_ids=("$@") k ami snap snaps i=0 total
  [[ "$keep_n" =~ ^[0-9]+$ ]] || die "prune_images: keep count '$keep_n' is not a number"
  for k in "${keep_ids[@]}"; do
    [[ -z "$k" || "$k" =~ ^ami-[0-9a-f]{8,17}$ ]] || die "prune_images: refusing to prune around '$k' (not an AMI id)"
  done
  local images
  images="$(aws ec2 describe-images --region "$REGION" --owners self \
    --filters "Name=tag:agent,Values=$OWNER" "Name=tag:capability,Values=$CAPABILITY" \
    --query 'reverse(sort_by(Images,&CreationDate))[].ImageId' --output text | tr '\t' '\n' | sed '/^$/d')" \
    || die "could not list $OWNER/$CAPABILITY images"
  total="$(printf '%s\n' "$images" | sed '/^$/d' | wc -l | tr -d ' ')"
  note "Pruning $OWNER/$CAPABILITY images: $total found, keeping the newest $keep_n${keep_ids[*]:+ and ${keep_ids[*]}}"
  while read -r ami; do
    [[ -n "$ami" ]] || continue
    i=$((i + 1))
    if [[ ! "$ami" =~ ^ami-[0-9a-f]{8,17}$ ]]; then warn "  skipping '$ami' (not an AMI id)"; continue; fi
    if ((i <= keep_n)); then note "  keeping $ami (newest $i of $keep_n)"; continue; fi
    for k in "${keep_ids[@]}"; do
      if [[ "$ami" == "$k" ]]; then note "  keeping $ami (pinned)"; continue 2; fi
    done
    snaps="$(aws ec2 describe-images --region "$REGION" --image-ids "$ami" \
      --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)"
    note "  deregistering $ami"
    aws ec2 deregister-image --region "$REGION" --image-id "$ami"
    for snap in $snaps; do
      [[ "$snap" =~ ^snap-[0-9a-f]{8,17}$ ]] || continue
      aws ec2 delete-snapshot --region "$REGION" --snapshot-id "$snap" || warn "could not delete $snap"
    done
  done <<<"$images"
}
