"""
FastAPI entrypoint for the open Indic voice service (Telugu/Hindi ASR + TTS).
=====================================================================================
Called over HTTP by the livekit-service (backend/../livekit-service/indic_clients.py) when the
Settings engine map routes Telugu/Hindi STT to IndicConformer/IndicWhisper or TTS to Indic
Parler-TTS. The livekit-service keeps Sarvam as its default + fallback, so this service is
optional and only needed for the fully-open Indic path (GPU recommended).

    POST /stt  {audio_b64 (WAV), language, engine}  -> {"text": "..."}
    POST /tts  {text, language, voice?}              -> audio/wav
    GET  /health

Run:  python main.py           (defaults to 0.0.0.0:8005)
"""

import base64
import os

from dotenv import load_dotenv

load_dotenv(override=True)

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from loguru import logger
from pydantic import BaseModel

import engine

app = FastAPI(title="indic-voice")


class SttRequest(BaseModel):
    audio_b64: str
    language: str = "te-IN"
    engine: str = "indic-conformer"


class TtsRequest(BaseModel):
    text: str
    language: str = "te-IN"
    voice: str | None = None


@app.get("/health")
async def health():
    return {"ok": True, "service": "indic-voice", **engine.status()}


# Sync `def` so FastAPI runs these blocking model calls in its threadpool (keeps the loop free).
@app.post("/stt")
def stt(req: SttRequest):
    try:
        audio = base64.b64decode(req.audio_b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad audio_b64: {e}")
    try:
        text = engine.transcribe(audio, req.language, req.engine)
        return {"text": text}
    except Exception as e:
        logger.exception(f"STT failed ({req.engine}, {req.language}): {e}")
        raise HTTPException(status_code=500, detail=f"stt failed: {e}")


@app.post("/tts")
def tts(req: TtsRequest):
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="empty text")
    try:
        wav = engine.synthesize(req.text, req.language, req.voice)
        return Response(content=wav, media_type="audio/wav")
    except Exception as e:
        logger.exception(f"TTS failed ({req.language}): {e}")
        raise HTTPException(status_code=500, detail=f"tts failed: {e}")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8005")),
    )
