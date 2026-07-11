"""Headless greeting smoke test for the livekit-service bridge.

Connects like the Node LiveKitProvider does: sends the TEXT start config, then a 0x02
'go' control, and verifies the agent greets — i.e. LLM + (Sarvam) TTS + event bridge all
work end-to-end WITHOUT a microphone or Chatterbox. Run: python smoke_test.py [te-IN|en-IN]
"""
import asyncio
import json
import os
import sys

import websockets

LANG = sys.argv[1] if len(sys.argv) > 1 else "te-IN"
URL = "ws://localhost:8766/ws"
TAG_CONTROL = 0x02


async def main():
    start = {
        "type": "start",
        "session_id": "smoke-" + LANG,
        "language": LANG,
        "system_prompt": (
            "You are a warm hospital intake nurse. Greet the patient in one short sentence "
            "and ask their name. Speak only the spoken words."
        ),
        "voice": "neha",
        "temperature": 0.6,
    }
    _em = os.getenv("SMOKE_ENGINE_MAP")  # e.g. '{"te-IN":{"stt":"indic-conformer","tts":"parler"}}'
    if _em:
        start["engine_map"] = json.loads(_em)
    got = {"ready": False, "bot_started": False, "bot_transcript": None,
           "bot_stopped": False, "audio_bytes": 0, "error": None}
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps(start))
        # send 'go' shortly after ready
        async def driver():
            while not got["ready"] and got["error"] is None:
                await asyncio.sleep(0.05)
            await ws.send(bytes([TAG_CONTROL]) + json.dumps({"type": "go"}).encode())

        drive = asyncio.create_task(driver())
        try:
            async with asyncio.timeout(45):
                async for msg in ws:
                    if isinstance(msg, (bytes, bytearray)):
                        got["audio_bytes"] += len(msg)
                        continue
                    ev = json.loads(msg)
                    t = ev.get("type")
                    if t == "ready":
                        got["ready"] = True
                    elif t == "bot_started_speaking":
                        got["bot_started"] = True
                    elif t == "bot_transcript":
                        got["bot_transcript"] = ev.get("text")
                    elif t == "bot_stopped_speaking":
                        got["bot_stopped"] = True
                        break
                    elif t == "error":
                        got["error"] = ev.get("message")
                        break
        except (asyncio.TimeoutError, TimeoutError):
            pass
        drive.cancel()

    print(json.dumps(got, ensure_ascii=False, indent=2))
    ok = (got["ready"] and got["bot_started"] and got["bot_transcript"]
          and got["audio_bytes"] > 0 and got["error"] is None)
    print("SMOKE_OK" if ok else "SMOKE_FAIL")
    sys.exit(0 if ok else 1)


asyncio.run(main())
