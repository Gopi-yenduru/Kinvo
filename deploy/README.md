# On-Prem Deployment Runbook

Containerized stack: **Postgres + Backend (Node) + nginx (TLS + SPA + reverse proxy)**.

## Prerequisites (on the hospital server)
- Docker + Docker Compose
- TLS certificate for your hostname (e.g. `intake.hospital.local`) — from the hospital CA or Let's Encrypt
- A signed **Data Processing Agreement with Sarvam** (patient voice/transcripts are processed in Sarvam's cloud)
- Clinician sign-off on the intake flow; DPDP/ABDM compliance review

## Setup
1. `cp deploy/.env.example deploy/.env` and fill in **every** value (strong `PGPASSWORD`, `JWT_SECRET` via `openssl rand -hex 32`, `ADMIN_PASSWORD`, `SARVAM_API_KEY`, `PUBLIC_URL`).
2. Put your certs in `deploy/certs/` as `fullchain.pem` and `privkey.pem`.
3. Build & start:
   ```
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
   ```
4. Browse to `https://<PUBLIC_URL>`, log in as `admin` / `ADMIN_PASSWORD`, then immediately create real staff accounts (`POST /api/admin/users`) and change/disable the default admin.

## Data & backups
- Postgres data persists in the `pgdata` volume.
- **Schedule backups**: `docker compose -f deploy/docker-compose.prod.yml exec db pg_dump -U $PGUSER medintake > backup_$(date +%F).sql` (cron nightly, store off-box, test restores).

## Encryption at rest (PHI)
- Run the server on a **LUKS/BitLocker-encrypted volume** (covers the Postgres `pgdata` volume) — the standard on-prem approach.
- Optionally add column-level encryption (pgcrypto) for the most sensitive fields later.

## Operations
- Logs: `docker compose -f deploy/docker-compose.prod.yml logs -f backend`
- Restart policy is `unless-stopped`; the host's Docker service should start on boot.
- Health: `https://<PUBLIC_URL>/api/health` (proxied) and container healthchecks.

## Updating
`git pull` then re-run the `up -d --build` command. Postgres schema is created idempotently on boot; for column changes add a migration step before scaling.
