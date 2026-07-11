"""
Chatterbox-Turbo TTS client (English) for the LiveKit voice service.
=====================================================================================
Chatterbox-Turbo is English-only and is served OUT OF PROCESS by a separate
Chatterbox-TTS-Server (https://github.com/devnen/Chatterbox-TTS-Server), which exposes
an OpenAI-compatible `POST /v1/audio/speech` endpoint. Keeping the (GPU-hungry) model in
its own server means this service — and the whole Node/Python stack — stays light and the
TTS box can be scaled/placed independently.

This is a thin async client, deliberately NOT a `livekit.agents.tts.TTS` subclass: the
bot drives TTS itself (Chatterbox for en, the Sarvam plugin for te/hi), so a plain
"text → PCM16 @24 kHz" coroutine is the simplest reliable contract. Audio is normalised
to mono 16-bit PCM at 24 kHz to match the browser playback path (see AUDIO_OUT_RATE).
"""

import io
import os
import wave

import httpx
import numpy as np
from loguru import logger

OUT_RATE = 24000  # what the browser's playback AudioContext expects


class ChatterboxTTS:
    def __init__(
        self,
        base_url: str | None = None,
        voice: str | None = None,
        model: str | None = None,
        timeout: float = 180.0,
    ):
        # CHATTERBOX_URL may be given with or without the /v1 suffix — normalise to the base.
        raw = (base_url or os.getenv("CHATTERBOX_URL") or "http://localhost:8004").strip().rstrip("/")
        if raw.endswith("/v1"):
            raw = raw[: -len("/v1")]
        self.base_url = raw
        self.voice = voice or os.getenv("CHATTERBOX_VOICE", "default")
        self.model = model or os.getenv("CHATTERBOX_MODEL", "chatterbox-turbo")
        self.timeout = timeout
        # Long read timeout: on CPU, Chatterbox synthesis of a single sentence can take many
        # seconds (and the server blocks while it runs), so a short timeout would abort it.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=8.0))

    async def aclose(self):
        await self._client.aclose()

    async def health(self) -> bool:
        """Best-effort reachability check used by /health and at session start. Uses a short
        timeout so a genuinely-down server fails fast (a busy server may briefly fail this
        while it blocks on a synthesis — that's fine, the session just retries)."""
        try:
            r = await self._client.get(f"{self.base_url}/v1/audio/voices", timeout=8.0)
            return r.status_code < 500
        except Exception:
            return False

    async def synthesize(self, text: str) -> bytes:
        """Return the whole utterance as mono PCM16 @24 kHz. The bot chunks it for the wire."""
        text = (text or "").strip()
        if not text:
            return b""
        payload = {
            "model": self.model,
            "input": text,
            "voice": self.voice,
            "response_format": "wav",  # easiest to parse reliably across server versions
        }
        r = await self._client.post(f"{self.base_url}/v1/audio/speech", json=payload)
        r.raise_for_status()
        return _to_pcm16_mono(r.content, OUT_RATE)


def _to_pcm16_mono(wav_bytes: bytes, target_rate: int) -> bytes:
    """Decode a WAV response to mono int16 PCM at `target_rate`.

    audioop was removed in Python 3.13, so channel-mixing and resampling are done with
    numpy. Linear interpolation is plenty for speech and matches the resampler used on
    the Node side (SarvamProvider.downsample)."""
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            n_channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            in_rate = w.getframerate()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        logger.warning(f"Chatterbox returned non-WAV / unreadable audio ({e}); passing through raw")
        return wav_bytes

    if sampwidth == 2:
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
    elif sampwidth == 1:  # 8-bit unsigned
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) * 256.0
    elif sampwidth == 4:  # 32-bit int
        samples = (np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 65536.0)
    else:
        logger.warning(f"Unsupported WAV sample width {sampwidth}; passing through raw")
        return frames

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    if in_rate != target_rate and samples.size:
        duration = samples.size / float(in_rate)
        out_len = int(round(duration * target_rate))
        if out_len > 0:
            xp = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
            x = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
            samples = np.interp(x, xp, samples)

    samples = np.clip(samples, -32768.0, 32767.0).astype(np.int16)
    return samples.tobytes()
