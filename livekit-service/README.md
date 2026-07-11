# livekit-service — LiveKit Agents + Chatterbox-Turbo voice engine

Open-source voice pipeline for the Pre-Consultation intake agent, selectable from the
Dashboard **Voice Engine** dropdown ("LiveKit Agents + Chatterbox-Turbo"). It is a sibling
of `pipecat-service/`: a Python microservice bridged to the **unchanged** frontend by the
Node backend (`backend/src/providers/LiveKitProvider.ts`). Node keeps ALL business logic
(DB writes, red flags, session lifecycle); this service is a pure voice loop.

## Engine mapping
Chatterbox-Turbo is **English-only**, so the engine is hybrid — same language split the
Pipecat engine uses:

| Language | STT | LLM | TTS |
|----------|-----|-----|-----|
| English `en-IN`      | Sarvam (or OpenAI, `LIVEKIT_EN_STT=openai`) | OpenAI `gpt-4o` | **Chatterbox-Turbo** (HTTP server) |
| Telugu `te-IN` / Hindi `hi-IN` | Sarvam | OpenAI `gpt-4o` | **Sarvam** (Bulbul) |

Silero VAD (LiveKit's plugin) handles endpointing and barge-in. Turn-taking is orchestrated
explicitly (see `bot.py`) because `AgentSession` is room/WebRTC-centric; the LiveKit Agents
**plugin** classes it uses are room-independent.

## Prerequisites
1. **Python 3.10–3.12** and the deps: `pip install -r requirements.txt`
   (first run downloads the Silero VAD model).
2. **A Chatterbox TTS server** for the English voice — self-host
   [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) with the
   `chatterbox-turbo` model and its OpenAI-compatible `/v1/audio/speech` endpoint. A GPU
   (NVIDIA/AMD) is strongly recommended for low latency; CPU works but is slow.
3. Keys: `OPENAI_API_KEY`, `SARVAM_API_KEY` (see `.env.example`).

## Run
```bash
cd livekit-service
cp .env.example .env      # fill in keys + CHATTERBOX_URL
python main.py            # serves 0.0.0.0:8766
```
Health check: `GET http://localhost:8766/health`.

Point the Node backend at it with **`LIVEKIT_URL=http://localhost:8766`** (see
`backend/.env.example`), then pick **LiveKit Agents + Chatterbox-Turbo** in the Dashboard.

## Bridge protocol (Node ⇆ this service)
Identical to `pipecat-service`. Node → Python (binary, 1-byte tag): `0x01`+PCM16LE@16 kHz
mic audio, `0x02`+UTF-8 JSON control (`go`/`interrupt`/`end`). Python → Node: raw
PCM16LE@24 kHz agent audio + JSON events (`ready`, `user_started_speaking`,
`user_transcript`, `bot_started_speaking`, `bot_transcript`, `bot_stopped_speaking`,
`tool_call`, `error`). The two intake tools (`red_flag_detected`, `end_session`) are
forwarded to Node, which persists them — keep them in sync with `LiveKitProvider`.

## Note on API versions
Written against the documented `livekit-agents` / `livekit-plugins-sarvam` (>=1.6) APIs.
As with `pipecat-service` when it was first added, exact plugin kwargs and event fields can
shift between releases — construction is wrapped defensively where names vary, but do a
short finalize-and-test pass against the installed versions on the GPU host (STT recognize,
Sarvam TTS kwargs, Silero `VADEvent.frames`). The live mic loop (barge-in, latency) can only
be judged with real audio.
