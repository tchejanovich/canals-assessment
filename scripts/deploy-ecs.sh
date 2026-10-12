#!/usr/bin/env bash
# Usage: AWS_PROFILE=<profile> AWS_REGION=<region> ECS_CLUSTER=<cluster> ./scripts/deploy-ecs.sh <service>
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -ne 1 ]]; then
  printf 'Usage: AWS_PROFILE=<profile> AWS_REGION=<region> ECS_CLUSTER=<cluster> %s <service>\n' "$0" >&2
  exit 2
fi

ECS_SERVICE="$1"
ECS_CLUSTER="${ECS_CLUSTER:-default}"
ECR_REPOSITORY="${ECR_REPOSITORY:-canals-assessment}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"

if ! command -v aws >/dev/null 2>&1; then
  printf '%s\n' 'Error: AWS CLI is required.' >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' 'Error: jq is required.' >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [[ -z "${AWS_REGION}" ]]; then
  printf '%s\n' 'Error: set AWS_REGION or configure a default AWS CLI region.' >&2
  exit 1
fi

SERVICE_STATUS="$(aws ecs describe-services \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE}" \
  --query 'services[0].status' \
  --output text)"
if [[ "${SERVICE_STATUS}" != 'ACTIVE' ]]; then
  printf 'Error: ECS service %s was not found or is not ACTIVE in cluster %s.\n' \
    "${ECS_SERVICE}" "${ECS_CLUSTER}" >&2
  exit 1
fi

TASK_DEFINITION_ARN="$(aws ecs describe-services \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE}" \
  --query 'services[0].taskDefinition' \
  --output text)"
TASK_DEFINITION="$(aws ecs describe-task-definition \
  --region "${AWS_REGION}" \
  --task-definition "${TASK_DEFINITION_ARN}" \
  --query taskDefinition \
  --output json)"

TARGET_CONTAINER_COUNT="$(jq --arg repository "${ECR_REPOSITORY}" '
  def uses_repository:
    (.image | split("@")[0] | split(":")[0]) as $ref
    | ($ref == $repository or ($ref | endswith("/" + $repository)));
  [.containerDefinitions[] | select(uses_repository)] | length
' <<<"${TASK_DEFINITION}")"
if [[ "${TARGET_CONTAINER_COUNT}" -eq 0 ]]; then
  printf 'Error: no container in task definition %s uses ECR repository %s.\n' \
    "${TASK_DEFINITION_ARN}" "${ECR_REPOSITORY}" >&2
  printf 'Set ECR_REPOSITORY to the repository used by the service.\n' >&2
  exit 1
fi

printf 'Building and pushing a fresh image for ECS service %s...\n' "${ECS_SERVICE}"
AWS_REGION="${AWS_REGION}" ECR_REPOSITORY="${ECR_REPOSITORY}" \
  "${SCRIPT_DIR}/deploy-ecr.sh" "${IMAGE_TAG}"

AWS_ACCOUNT_ID="$(aws sts get-caller-identity \
  --region "${AWS_REGION}" \
  --query Account \
  --output text)"
IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"

TASK_DEFINITION_FILE="$(mktemp)"
trap 'rm -f "${TASK_DEFINITION_FILE}"' EXIT

jq --arg repository "${ECR_REPOSITORY}" --arg image "${IMAGE_URI}" '
  def uses_repository:
    (.image | split("@")[0] | split(":")[0]) as $ref
    | ($ref == $repository or ($ref | endswith("/" + $repository)));
  del(
    .taskDefinitionArn,
    .revision,
    .status,
    .requiresAttributes,
    .compatibilities,
    .registeredAt,
    .registeredBy,
    .deregistrationInProgress
  )
  | .containerDefinitions |= map(if uses_repository then .image = $image else . end)
' <<<"${TASK_DEFINITION}" >"${TASK_DEFINITION_FILE}"

NEW_TASK_DEFINITION_ARN="$(aws ecs register-task-definition \
  --region "${AWS_REGION}" \
  --cli-input-json "file://${TASK_DEFINITION_FILE}" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

printf 'Updating ECS service %s in cluster %s...\n' "${ECS_SERVICE}" "${ECS_CLUSTER}"
aws ecs update-service \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --service "${ECS_SERVICE}" \
  --task-definition "${NEW_TASK_DEFINITION_ARN}" >/dev/null

printf 'Waiting for ECS service %s to become stable...\n' "${ECS_SERVICE}"
aws ecs wait services-stable \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE}"

printf '\nDeployment complete.\nImage: %s\nTask definition: %s\n' \
  "${IMAGE_URI}" "${NEW_TASK_DEFINITION_ARN}"
