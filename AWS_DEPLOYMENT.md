# AWS Deployment Guide for Medical Intake Voice Agent

This guide provides minimum steps to deploy the POC application to AWS ECS.

## Prerequisites
- AWS account with appropriate permissions
- AWS CLI installed and configured
- Docker installed locally

## Build and Push Docker Image

1. Build the Docker image:
```bash
docker build -t medical-intake-voice-agent .
```

2. Tag and push to ECR:
```bash
# Replace ACCOUNT-ID and REGION with your values
aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com

docker tag medical-intake-voice-agent:latest ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com/medical-intake-voice-agent:latest
docker push ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com/medical-intake-voice-agent:latest
```

## Deploy to ECS

1. Create ECR repository (if not exists):
```bash
aws ecr create-repository --repository-name medical-intake-voice-agent --region REGION
```

2. Update task-definition.json with your ACCOUNT-ID and REGION

3. Register task definition:
```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json --region REGION
```

4. Create ECS cluster (if not exists):
```bash
aws ecs create-cluster --cluster-name medical-intake-cluster --region REGION
```

5. Create service:
```bash
aws ecs create-service \
  --cluster medical-intake-cluster \
  --service-name medical-intake-service \
  --task-definition medical-intake-voice-agent \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-12345,subnet-67890],securityGroups=[sg-12345],assignPublicIp=ENABLED}" \
  --region REGION
```

## Environment Variables

Set the following in the ECS task definition:
- `OPENAI_API_KEY`: Your OpenAI API key with Realtime API access
- `NODE_ENV`: production
- `PORT`: 3002 (backend port)
- `DATABASE_PATH`: /data/medical_intake.db

## Networking

- The application runs on port 80 in the container
- Frontend is served statically by nginx
- Backend API is proxied through nginx
- WebSocket connections are supported

## Monitoring

- Container logs are sent to CloudWatch Logs
- Health checks verify the /health endpoint
- Use AWS ECS console to monitor service status

## Security Notes

- Replace placeholder values in task-definition.json
- Use IAM roles with least privilege
- Consider using AWS Secrets Manager for sensitive API keys in production
- Update security groups to restrict access as needed