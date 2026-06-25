# Production Roadmap — Medical Intake Voice Agent (Hospital Deployment)

Goal: hospital-wide, on-prem deployment, handling real patient health data (PHI), in Telugu, using the Sarvam cloud voice pipeline (STT → LLM → TTS).

> **Recommendation:** even with a hospital-wide goal, go live in **one supervised OPD room first** (pilot), prove value and safety, then scale. The work below supports scaling, but de-risk first.

## Non-engineering dependencies (line these up in parallel — cannot be coded away)
- **Clinician sign-off** on the intake question flow and red-flag logic (patient safety).
- **Compliance/legal**: India **DPDP Act 2023**; if integrating with national health infra, **ABDM/ABHA** standards. Consent capture + retention policy.
- **Data Processing Agreement with Sarvam** — patient voice/transcripts (PHI) are sent to Sarvam's cloud API. This MUST be covered by a DPA and compliance approval, since on-prem servers don't prevent that data leaving the hospital.
- **Hospital IT/network access** for on-prem servers, TLS certs, backups.

## Phase 1 — Security & data foundation
- [x] Remove hardcoded JWT secret; require strong `JWT_SECRET` from env (server won't boot without it).
- [x] Enforce bcrypt passwords; remove plaintext fallback; auto-migrate legacy admin.
- [x] Helmet security headers, rate limiting (login + API), restricted CORS, login input validation, generic auth errors.
- [x] **Migrate SQLite → PostgreSQL** — dual-client data layer (`DB_CLIENT=sqlite|postgres`); dev=SQLite, prod=Postgres. Verified.
- [x] **TLS/HTTPS** — nginx reverse proxy with TLS termination + HTTP→HTTPS redirect (`deploy/nginx.conf`).
- [x] **Real user management + RBAC** — `requireRole` middleware; admin-only `GET/POST /api/admin/users`; roles admin/doctor/nurse/clinician. Verified (403 for non-admin).
- [x] Secrets via env; `.gitignore` verified to exclude `.env`, `deploy/.env`, certs (`*.pem`).
- [x] **Encryption at rest** — application-level AES-256-GCM field encryption of PHI columns (patient_name, conversation message, intake answer, report content, red-flag symptoms) via `crypto-service.ts` + `ENCRYPTION_KEY`. Ciphertext at rest, decrypted on read; backward-compatible with legacy plaintext. (Also enable host disk encryption for defense-in-depth.)
- [x] **Rate limiting (enhanced)** — per-USER keying (decoded JWT) so hospital NAT IP isn't throttled as one; stricter `expensiveLimiter` (15/min) on the paid endpoints (session start, report generation).
- [ ] Force-change default admin password on first login (currently set via `ADMIN_PASSWORD`).

## Phase 2 — Reliability & ops
- [x] Global error handling — Express error middleware + `unhandledRejection`/`uncaughtException` handlers so the server doesn't hard-crash.
- [x] Process supervision + health checks — Docker `restart: unless-stopped` + compose healthcheck on Postgres.
- [x] **WebSocket auth** — `/ws` verifies the JWT on `join_session`; other WS messages require an authenticated socket.
- [x] **DB-aware `/health`** (503 when DB down) + admin metrics endpoint `/api/admin/metrics`.
- [x] PHI/secret log redaction — transcripts, agent text, and settings (API keys) no longer logged.
- [x] **Backup script** `npm run backup` (SQLite online backup or `pg_dump` → `backend/backups/`). ACTION: schedule (cron/Task Scheduler) + copy off-box + test restore.
- [ ] Structured logging library + log rotation; external monitoring/alerting.
- [x] **API-tier load test** (`npm run loadtest [users] [secs]`, `backend/scripts/loadtest.mjs`) — 100 concurrent users → ~3,100 req/s, 0 errors, p99 73ms (single-process SQLite). Rate limiter verified engaging under burst (300 ok / 50× 429).
- [ ] **Voice-pipeline** load is separate: each live session holds STT+TTS WS to Sarvam + LLM calls — bound by Sarvam concurrency/quota + cost, not the app. Needs Sarvam capacity planning + Postgres for prod. Handle Sarvam rate limits / backpressure / retries.
- [x] WebSocket/STT/TTS reconnection hardening (ensureStt/per-utterance TTS already added).

## Phase 3 — Clinical & integration  (not started — larger product work)
- [ ] Doctor review/approval workflow for each generated intake report.
- [ ] Consent capture at session start; full audit trail (who accessed what, when).
- [~] EMR/HIS integration — **FHIR R4 export DONE** (`GET /api/sessions/:id/fhir`, doctor/admin): Bundle of Patient/Encounter/QuestionnaireResponse/Flag/DocumentReference + UI "Export FHIR" button. REMAINING: configure transport to push the bundle to the hospital's specific FHIR endpoint (their base URL + auth).
- [ ] Configurable, clinician-approved intake templates per department.

## Phase 4 — On-prem deployment
- [x] Containerize — `backend/Dockerfile`, `frontend/Dockerfile`, `deploy/docker-compose.prod.yml` (Postgres + backend + nginx/TLS), `deploy/.env.example`, runbook `deploy/README.md`.
- [ ] Deploy on hospital server(s); real domain + CA-signed TLS; firewalled; scheduled backups; on-call.
- [ ] Staff training; rollback plan; pilot → phased department rollout.

## Current stack (as built)
- Frontend: React + Vite (`frontend/`)
- Backend: Node + Express + TypeScript (`backend/`)
- DB: SQLite via `better-sqlite3` (dev) → **must become PostgreSQL for prod**
- Voice: Sarvam AI — Streaming STT (saaras), Chat (`sarvam-30b`, `reasoning_effort:null`), Streaming TTS (bulbul, `te-IN`)
- Auth: JWT (env secret) + bcrypt
