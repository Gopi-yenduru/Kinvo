"""
FastAPI entrypoint for the LiveKit Agents + Chatterbox-Turbo voice service.
=====================================================================================
The Node backend (backend/src/providers/LiveKitProvider.ts) opens ONE websocket per
intake session:

    1. TEXT  {"type":"start", session_id, language, system_prompt, voice, temperature}
    2. everything after that follows the tagged-binary bridge protocol (see bot.py)

Run locally:   python main.py          (defaults to 0.0.0.0:8766)
Health check:  GET /health
"""

import json
import os

from dotenv import load_dotenv

load_dotenv(override=True)

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from loguru import logger

from bot import run_bot

app = FastAPI(title="livekit-voice")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "livekit-voice",
        "openai_key": bool(os.getenv("OPENAI_API_KEY")),
        "sarvam_key": bool(os.getenv("SARVAM_API_KEY")),
        "chatterbox_url": os.getenv("CHATTERBOX_URL", "http://localhost:8004"),
    }


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    # First message must be the TEXT start-config from the Node backend.
    try:
        raw = await websocket.receive_text()
        cfg = json.loads(raw)
        if cfg.get("type") != "start":
            raise ValueError("first message must be {'type':'start', ...}")
    except WebSocketDisconnect:
        return
    except Exception as e:
        logger.warning(f"Bad session start: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": f"bad start message: {e}"}))
            await websocket.close(code=4400)
        except Exception:
            pass
        return

    try:
        await run_bot(websocket, cfg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception(f"Session {cfg.get('session_id')} crashed: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
            await websocket.close(code=1011)
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8766")),
    )
