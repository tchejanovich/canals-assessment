#!/usr/bin/env bash
# Usage: AWS_PROFILE=<profile> AWS_REGION=<region> ./scripts/deploy-ecr.sh [image-tag]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

ECR_REPOSITORY="${ECR_REPOSITORY:-canals-assessment}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
IMAGE_TAG="${1:-$(date -u +%Y%m%d%H%M%S)}"

if ! command -v aws >/dev/null 2>&1; then
  printf '%s\n' 'Error: AWS CLI is required.' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Error: Docker is required.' >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [[ -z "${AWS_REGION}" ]]; then
  printf '%s\n' 'Error: set AWS_REGION or configure a default AWS CLI region.' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Error: Docker is not running.' >&2
  exit 1
fi

AWS_ACCOUNT_ID="$(aws sts get-caller-identity \
  --region "${AWS_REGION}" \
  --query Account \
  --output text)"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"

if ! aws ecr describe-repositories \
  --region "${AWS_REGION}" \
  --repository-names "${ECR_REPOSITORY}" >/dev/null 2>&1; then
  printf 'Creating ECR repository %s in %s...\n' "${ECR_REPOSITORY}" "${AWS_REGION}"
  aws ecr create-repository \
    --region "${AWS_REGION}" \
    --repository-name "${ECR_REPOSITORY}" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 >/dev/null
fi

printf 'Logging in to %s...\n' "${ECR_REGISTRY}"
aws ecr get-login-password --region "${AWS_REGION}" |
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

printf 'Building %s...\n' "${IMAGE_URI}"
docker build \
  --platform "${DOCKER_PLATFORM}" \
  --file "${PROJECT_ROOT}/Dockerfile" \
  --tag "${IMAGE_URI}" \
  "${PROJECT_ROOT}"

printf 'Pushing %s...\n' "${IMAGE_URI}"
docker push "${IMAGE_URI}"

printf '\nImage pushed to ECR:\n%s\n' "${IMAGE_URI}"
