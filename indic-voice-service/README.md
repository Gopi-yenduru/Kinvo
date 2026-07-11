# indic-voice-service — open Indic STT/TTS (Telugu/Hindi)

Optional GPU-ready microservice that serves **open** Indian-language voice models to the
LiveKit engine, so Telugu/Hindi can run fully self-hosted (no Sarvam cloud). The
`livekit-service` calls it over HTTP **only when** the Settings engine map selects an Indic
engine — and it always keeps **Sarvam as the default + automatic fallback**, so this service is
optional and Telugu keeps working without it.

## Models
| Stage | Engine(s) | Model |
|-------|-----------|-------|
| STT | IndicConformer | [ai4bharat/indic-conformer-600m-multilingual](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) (22 langs, CTC+RNNT) |
| STT | IndicWhisper | per-language Whisper finetunes (e.g. `vasista22/whisper-telugu-medium`) |
| TTS | Indic Parler-TTS | [ai4bharat/indic-parler-tts](https://huggingface.co/ai4bharat/indic-parler-tts) (21 langs) |

Models load **lazily** (first request) and download weights from HuggingFace on first use.

## API
- `POST /stt` `{audio_b64 (WAV), language, engine}` → `{"text": "..."}` — `engine` ∈ `indic-conformer` | `indic-whisper`.
- `POST /tts` `{text, language, voice?}` → `audio/wav`.
- `GET /health`.

## Run
```bash
cd indic-voice-service
cp .env.example .env
pip install -r requirements.txt      # GPU: install CUDA torch wheels first (see requirements.txt)
python main.py                       # serves 0.0.0.0:8005
```
Then point the livekit-service at it: `INDIC_VOICE_URL=http://localhost:8005` (see
`livekit-service/.env`), and in the app **Settings → LiveKit provider → Telugu/Hindi Engines**
choose IndicConformer/IndicWhisper (STT) and Indic Parler-TTS (TTS).

## ⚠️ Hardware
These are heavy models. **GPU strongly recommended** — Indic Parler-TTS is autoregressive and on
CPU is very slow (tens of seconds/sentence); IndicConformer (CTC) is lighter. If it's slow or not
running, the livekit-service transparently falls back to Sarvam.

## Note on API versions
Written against the documented HF APIs (`AutoModel(trust_remote_code=True)` for IndicConformer,
the `parler_tts` package for TTS, `transformers` ASR pipeline for IndicWhisper). Model call
signatures occasionally shift between releases — do a short finalize pass on the GPU host if a
call errors (`engine.py` isolates each model behind one function).
