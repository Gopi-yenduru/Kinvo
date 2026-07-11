# Pipecat Voice Service

Open-source [Pipecat](https://github.com/pipecat-ai/pipecat) voice pipeline that can
replace the in-house STT→LLM→TTS orchestration. The Node backend keeps owning the
frontend WebSocket contract, database writes and session lifecycle — this service is
only the voice loop (Silero VAD → STT → LLM with tools → TTS).

Select it from the **Dashboard → Voice Engine** dropdown (or Settings → Provider →
"Pipecat (Open Source)"). Sessions then stream through this service instead of the
in-house pipeline in `backend/src/providers/SarvamProvider.ts`.

## Engines per language

| Language | STT | LLM | TTS |
|---|---|---|---|
| Telugu (te-IN) | Sarvam saaras | OpenAI gpt-4o (or Sarvam, via env) | Sarvam bulbul |
| Hindi (hi-IN) | Sarvam saaras | OpenAI gpt-4o (or Sarvam, via env) | Sarvam bulbul |
| English (en-IN) | OpenAI gpt-4o-transcribe | OpenAI gpt-4o | OpenAI gpt-4o-mini-tts |

Same API keys the Node backend already uses (`OPENAI_API_KEY`, `SARVAM_API_KEY`).

## Run locally (Windows/macOS/Linux)

```bash
cd pipecat-service
python -m venv venv
venv\Scripts\activate          # Windows   (source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
copy .env.example .env         # then fill in the two API keys
python main.py                 # listens on :8765
```

The Node backend finds it via `PIPECAT_URL` (defaults to `http://localhost:8765`) —
set it in `backend/.env` if you run this service elsewhere.

## Run with Docker

```bash
docker build -t pipecat-voice pipecat-service
docker run --env-file pipecat-service/.env -p 8765:8765 pipecat-voice
```

In the production compose stack (`deploy/docker-compose.prod.yml`) the service is
already wired as `pipecat` and the backend points at it via `PIPECAT_URL=http://pipecat:8765`.

## Bridge protocol (Node ⇆ this service)

One WebSocket per session at `/ws`:

1. Node sends TEXT `{"type":"start", session_id, language, system_prompt, voice, temperature}`.
2. After that, Node sends BINARY frames — `0x01 + PCM16LE@16kHz` mic audio, or
   `0x02 + UTF-8 JSON` control (`go` = start greeting, `interrupt`, `end`).
3. Python sends BINARY raw PCM16LE@24kHz TTS audio, and TEXT JSON events
   (`ready`, `user_transcript`, `bot_transcript`, `bot_started/stopped_speaking`,
   `user_started/stopped_speaking`, `tool_call`, `error`).

Tool calls (`red_flag_detected`, `end_session`) are forwarded to Node, which persists
red flags and drives the session end — identical behaviour to the in-house pipeline.
