"""
HTTP clients for the open-source Indic voice models (Telugu/Hindi), served by the separate
`indic-voice-service` (see that folder). Kept out-of-process for the same reason as Chatterbox:
the models (IndicConformer / IndicWhisper ASR, Indic Parler-TTS) are heavy and GPU-preferred, so
they run on their own (GPU) host and this stays light. Sarvam remains the default + fallback in
bot.py, so Telugu keeps working when this service isn't running.

Contract (INDIC_VOICE_URL, default http://localhost:8005):
  POST /stt  {audio_b64 (WAV), language, engine}  -> {"text": "..."}
  POST /tts  {text, language, voice?}              -> audio/wav bytes
  GET  /health
"""

import base64
import io
import os
import wave

import httpx
from loguru import logger

from chatterbox_tts import _to_pcm16_mono  # WAV -> mono PCM16 @ target rate (reused)

OUT_RATE = 24000   # browser playback rate for TTS
ASR_RATE = 16000   # what the ASR models expect


def _default_url() -> str:
    raw = (os.getenv("INDIC_VOICE_URL") or "http://localhost:8005").strip().rstrip("/")
    return raw[:-3] if raw.endswith("/v1") else raw


def _frames_to_wav(frames, sample_rate: int) -> bytes:
    """Concatenate LiveKit AudioFrames into a mono 16-bit WAV (what /stt expects)."""
    pcm = b"".join(bytes(f.data) for f in frames)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class IndicAsr:
    """IndicConformer / IndicWhisper ASR via the indic-voice-service."""

    def __init__(self, base_url: str | None = None, timeout: float = 60.0):
        self.base_url = base_url or _default_url()
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=8.0))

    async def aclose(self):
        await self._client.aclose()

    async def health(self) -> bool:
        try:
            r = await self._client.get(f"{self.base_url}/health", timeout=8.0)
            return r.status_code < 500
        except Exception:
            return False

    async def transcribe(self, frames, language: str, engine: str) -> str:
        if not frames:
            return ""
        sr = getattr(frames[0], "sample_rate", ASR_RATE) or ASR_RATE
        wav = _frames_to_wav(frames, sr)
        payload = {
            "audio_b64": base64.b64encode(wav).decode("ascii"),
            "language": language,
            "engine": engine,
        }
        r = await self._client.post(f"{self.base_url}/stt", json=payload)
        r.raise_for_status()
        return str((r.json() or {}).get("text", "")).strip()


class IndicTts:
    """Indic Parler-TTS via the indic-voice-service. Returns mono PCM16 @24 kHz."""

    def __init__(self, base_url: str | None = None, voice: str | None = None, timeout: float = 180.0):
        self.base_url = base_url or _default_url()
        self.voice = voice or os.getenv("INDIC_TTS_VOICE", "")
        # Long read timeout: Parler-TTS is autoregressive (slow on CPU; the server blocks per synth).
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=8.0))

    async def aclose(self):
        await self._client.aclose()

    async def health(self) -> bool:
        try:
            r = await self._client.get(f"{self.base_url}/health", timeout=8.0)
            return r.status_code < 500
        except Exception:
            return False

    async def synthesize(self, text: str, language: str) -> bytes:
        text = (text or "").strip()
        if not text:
            return b""
        payload = {"text": text, "language": language}
        if self.voice:
            payload["voice"] = self.voice
        r = await self._client.post(f"{self.base_url}/tts", json=payload)
        r.raise_for_status()
        return _to_pcm16_mono(r.content, OUT_RATE)
