#!/usr/bin/env bash
# Deploy cap-mcp-bridge to AWS App Runner as a long-lived HTTP MCP server.
#
# App Runner (rather than Lambda or a serverless platform) because the streamable HTTP transport is
# stateful: it keeps one MCP server per session in memory and fetches $metadata once at startup.
# That needs a warm, long-lived process.
#
# Idempotent: run it again to ship a new image to the same service.
#
#   ./deploy/aws/deploy.sh
#   CAP_MCP_URL=https://my-service/odata/v4/catalog SERVICE_NAME=my-bridge ./deploy/aws/deploy.sh
#
# Read deploy/aws/README.md first. The deployed endpoint has NO inbound authentication.
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
SERVICE_NAME="${SERVICE_NAME:-cap-mcp-bridge}"
ECR_REPO="${ECR_REPO:-cap-mcp-bridge}"
ROLE_NAME="${ROLE_NAME:-AppRunnerECRAccessRole}"
CPU="${CPU:-0.25 vCPU}"
MEMORY="${MEMORY:-0.5 GB}"
TARGET_URL="${CAP_MCP_URL:-https://services.odata.org/V4/Northwind/Northwind.svc}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found. Install AWS CLI v2 and re-run."
docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and re-run."

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "Not authenticated to AWS. Run 'aws configure' (or 'aws sso login') and re-run."
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

say "Account ${ACCOUNT_ID}, region ${AWS_REGION}"
echo "service : ${SERVICE_NAME}"
echo "image   : ${IMAGE}"
echo "target  : ${TARGET_URL}"

# ---- 1. ECR repository ----------------------------------------------------
say "Ensuring ECR repository ${ECR_REPO}"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository \
       --repository-name "$ECR_REPO" \
       --image-scanning-configuration scanOnPush=true \
       --region "$AWS_REGION" >/dev/null
echo "ok"

# ---- 2. Build and push ----------------------------------------------------
say "Logging in to ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

say "Building image (linux/amd64)"
# App Runner runs amd64; --platform keeps this correct if you ever build from an ARM machine.
docker build --platform linux/amd64 -t "$IMAGE" .

say "Pushing ${IMAGE}"
docker push "$IMAGE"

# ---- 3. IAM role so App Runner can pull from a private ECR repo -----------
say "Ensuring IAM role ${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "build.apprunner.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess >/dev/null
  echo "created; waiting for IAM propagation"
  aws iam wait role-exists --role-name "$ROLE_NAME"
  sleep 10
else
  echo "ok"
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

# ---- 4. Create or update the App Runner service ---------------------------
SOURCE_CONFIG=$(cat <<JSON
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "3333",
      "RuntimeEnvironmentVariables": {
        "CAP_MCP_URL": "${TARGET_URL}",
        "CAP_MCP_TRANSPORT": "http",
        "CAP_MCP_HOST": "0.0.0.0",
        "CAP_MCP_PORT": "3333",
        "CAP_MCP_WRITE_ENABLED": "false",
        "CAP_MCP_LOG_LEVEL": "info"
      }
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": { "AccessRoleArn": "${ROLE_ARN}" }
}
JSON
)

EXISTING_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn | [0]" --output text 2>/dev/null || echo None)"

if [ "$EXISTING_ARN" = "None" ] || [ -z "$EXISTING_ARN" ]; then
  say "Creating App Runner service ${SERVICE_NAME}"
  SERVICE_ARN="$(aws apprunner create-service \
    --service-name "$SERVICE_NAME" \
    --region "$AWS_REGION" \
    --source-configuration "$SOURCE_CONFIG" \
    --instance-configuration "{\"Cpu\":\"${CPU}\",\"Memory\":\"${MEMORY}\"}" \
    --health-check-configuration '{"Protocol":"HTTP","Path":"/healthz","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
    --query Service.ServiceArn --output text)"
else
  say "Updating existing service ${SERVICE_NAME}"
  SERVICE_ARN="$EXISTING_ARN"
  aws apprunner update-service \
    --service-arn "$SERVICE_ARN" \
    --region "$AWS_REGION" \
    --source-configuration "$SOURCE_CONFIG" >/dev/null
fi

say "Waiting for the service to reach RUNNING (a few minutes on first deploy)"
for _ in $(seq 1 60); do
  STATUS="$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --region "$AWS_REGION" \
            --query Service.Status --output text)"
  printf '  %s\n' "$STATUS"
  case "$STATUS" in
    RUNNING) break ;;
    CREATE_FAILED|DELETE_FAILED) die "Service entered $STATUS. Check the App Runner logs in CloudWatch." ;;
  esac
  sleep 15
done

URL="https://$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --region "$AWS_REGION" \
       --query Service.ServiceUrl --output text)"

say "Deployed"
echo "url    : ${URL}"
echo "health : ${URL}/healthz"
echo "mcp    : ${URL}/mcp"
echo
echo "Verify:  curl -fsS ${URL}/healthz"
echo "Pause :  aws apprunner pause-service --service-arn ${SERVICE_ARN} --region ${AWS_REGION}"
echo "Delete:  aws apprunner delete-service --service-arn ${SERVICE_ARN} --region ${AWS_REGION}"
