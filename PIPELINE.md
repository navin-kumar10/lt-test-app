# CI/CD — Next.js Application

## 1. Overview

GitHub Actions is used to automatically validate and deploy the Next.js application whenever code is pushed to the `main` branch.

```text
Developer
   |
   | git push main
   v
GitHub Actions
   |
   +--> CI
   |    ├── Checkout
   |    ├── Node.js 24
   |    ├── npm ci
   |    ├── npm audit
   |    └── npm run build
   |
   +--> CD
        ├── SSH to EC2
        ├── Update source code
        ├── npm ci
        ├── npm run build
        ├── PM2 reload
        ├── Health check
        └── Public HTTPS check
```

## 2. Trigger

The workflow runs when:

* Code is pushed to `main`
* Manually using `workflow_dispatch`

## 3. CI — Continuous Integration

The CI job runs on an Ubuntu GitHub runner.

Steps:

```text
Checkout source
      ↓
Setup Node.js 24
      ↓
npm ci
      ↓
npm audit --omit=dev
      ↓
npm run build
```

The deployment job starts only when CI passes.

## 4. CD — Continuous Deployment

The CD job connects to the EC2 server using SSH.

Deployment steps:

```text
SSH to EC2
    ↓
Load NVM / Node.js 24
    ↓
git fetch origin main
    ↓
git reset --hard origin/main
    ↓
npm ci
    ↓
npm run build
    ↓
pm2 reload lt-test-app
    ↓
pm2 save
    ↓
Health check
```

## 5. Health Checks

The deployment verifies the application locally:

```bash
curl -fsS http://127.0.0.1:3000
```

It then verifies the public HTTPS endpoint:

```bash
curl -fsS https://nextjs.nkscloud.run.place/
```

If the health check fails, the deployment exits with an error and PM2 status/logs are collected for troubleshooting.

## 6. Deployment Security

SSH credentials are stored in GitHub Actions Secrets.

The workflow uses:

```text
EC2_HOST
EC2_USER
EC2_SSH_PORT
EC2_SSH_KEY
```

SSH uses:

```text
Port: 2222
StrictHostKeyChecking: enabled
```

The temporary SSH private key is removed after deployment.

## 7. Production Flow

```text
GitHub main
     |
     v
CI Validation
     |
     | CI Passed
     v
SSH :2222
     |
     v
EC2
     |
     +--> Update code
     +--> Install dependencies
     +--> Build
     +--> PM2 reload
     +--> Local health check
     |
     v
Public HTTPS Check
     |
     v
Deployment Successful
```

**Result:** Every successful push to `main` is automatically validated, built, deployed to EC2, and verified through the production HTTPS endpoint.
