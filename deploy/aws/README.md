# Deploying to AWS App Runner

Most people should not deploy this. The normal way to use `cap-mcp-bridge` is `npx` over stdio, on
the machine running the MCP client, which needs no server at all. Deploy only when you want a
**remote** MCP server that several people can point a client at without installing anything.

## Why App Runner and not a serverless platform

The streamable HTTP transport is stateful. It keeps one MCP server per session in an in-memory map,
holds server-to-client SSE streams open, and fetches `$metadata` once at startup to share across
sessions. Request-scoped serverless functions (Vercel, plain Lambda) lose that state between
invocations and refetch metadata on every cold start. App Runner keeps a warm, long-lived container,
which is the shape this server needs, and takes the repository's existing `Dockerfile` as-is.

## Read this before you deploy

**The MCP endpoint has no inbound authentication.** The auth in this project is outbound, to the
OData service. Anyone who has the URL can call every registered tool. That means:

- Point it only at data you are willing to serve publicly, or put it behind your own
  authenticating proxy. The default target is the public Northwind sample service.
- Leave `CAP_MCP_WRITE_ENABLED` at `false`. The deploy script sets it explicitly.
- Never build a variant where the caller supplies the target URL. That turns the service into an
  open proxy into whatever network it can reach.
- Consider `entityDeny` and `redactFields` if the target has anything you would rather not expose.

## Deploy

Prerequisites: AWS CLI v2 authenticated (`aws configure` or `aws sso login`), Docker running, and
permission to use ECR, IAM and App Runner.

```sh
./deploy/aws/deploy.sh
```

Defaults to the Northwind sample service in `us-east-1` on the smallest instance. Override with
environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CAP_MCP_URL` | Northwind | OData service the bridge fronts |
| `AWS_REGION` | `us-east-1` | Region for ECR and App Runner |
| `SERVICE_NAME` | `cap-mcp-bridge` | App Runner service name |
| `ECR_REPO` | `cap-mcp-bridge` | ECR repository name |
| `CPU` / `MEMORY` | `0.25 vCPU` / `0.5 GB` | Instance size |
| `IMAGE_TAG` | current git short SHA | Image tag to build and deploy |

The script creates the ECR repository, builds and pushes a `linux/amd64` image, creates the IAM role
App Runner needs to pull from a private repository, then creates the service, or updates it if it
already exists. It waits for `RUNNING` and prints the URL.

## Using the deployed server

```sh
curl -fsS https://<id>.<region>.awsapprunner.com/healthz
```

Point an MCP client at `https://<id>.<region>.awsapprunner.com/mcp`. In Claude Code:

```sh
claude mcp add --transport http northwind https://<id>.<region>.awsapprunner.com/mcp
```

## Cost, and turning it off

App Runner bills provisioned memory continuously and vCPU only while handling requests, so an idle
service on the smallest instance still costs a few dollars a month. It is not free tier. If you
deployed this on expiring credits, put a calendar reminder to delete it, because a dead demo link
is worse than never having published one.

```sh
# stop billing for compute but keep the service and its URL
aws apprunner pause-service --service-arn <arn> --region <region>
aws apprunner resume-service --service-arn <arn> --region <region>

# remove it entirely
aws apprunner delete-service --service-arn <arn> --region <region>
aws ecr delete-repository --repository-name cap-mcp-bridge --force --region <region>
aws iam detach-role-policy --role-name AppRunnerECRAccessRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
aws iam delete-role --role-name AppRunnerECRAccessRole
```

The script prints the exact pause and delete commands for your service when it finishes.
