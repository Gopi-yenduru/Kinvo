"""
LiveKit Agents voice pipeline for the Pre-Consultation intake agent.
=====================================================================================
One pipeline per session, driven over a single WebSocket by the Node backend's
LiveKitProvider. The Node side owns ALL business logic (DB writes, red-flag persistence,
session lifecycle, frontend contract); this service is a pure open-source voice loop:
VAD → STT → LLM (+tools) → TTS, built from LiveKit Agents plugins.

Why an explicit loop instead of `AgentSession`: `AgentSession` is built around LiveKit
room (WebRTC) I/O; running it without a room is only a testing path. So we drive the
LiveKit Agents *plugin* classes directly (they are room-independent) — Silero VAD for
endpointing/barge-in and the official Sarvam plugin for STT/TTS — and orchestrate turns
ourselves, exactly the explicit-state-machine style the in-house SarvamProvider uses.

── Engine mapping (Chatterbox-Turbo is English-only, hence the hybrid split) ─────────
    STT (all langs) : Sarvam plugin (Saarika)         [LIVEKIT_EN_STT=openai → OpenAI for en]
    LLM (all langs) : OpenAI gpt-4o (chat completions, with the 2 intake tools)
    TTS  en-IN      : Chatterbox-Turbo (separate CHATTERBOX_URL HTTP server)
    TTS  te-IN/hi-IN: Sarvam plugin (Bulbul)

── Bridge protocol (Node ⇆ this service) ───────────────────────────────────────────
Node → Python (BINARY, 1-byte tag): 0x01 + PCM16LE mono @16 kHz = mic audio;
    0x02 + UTF-8 JSON = control {"type":"go"|"interrupt"|"end"}. (The very first message
    on the socket is the TEXT {"type":"start", ...} config, consumed by main.py.)
Python → Node: BINARY raw PCM16LE mono @24 kHz = agent TTS audio; TEXT JSON events:
    ready / user_started_speaking / user_stopped_speaking / user_transcript /
    bot_started_speaking / bot_transcript / bot_stopped_speaking / tool_call / error.

NOTE: written against the documented LiveKit Agents / livekit-plugins-sarvam (>=1.6) APIs.
Like pipecat-service, exact plugin kwargs/events may need a finalize pass against the
installed version on the GPU host — construction is wrapped defensively where names vary.
"""

import asyncio
import json
import os

import numpy as np
from loguru import logger
from openai import AsyncOpenAI

from livekit import rtc
from livekit.agents import vad as vad_mod
from livekit.agents.utils import http_context
from livekit.plugins import silero

try:
    from livekit.plugins import sarvam
    SARVAM_AVAILABLE = True
except ImportError:
    SARVAM_AVAILABLE = False

try:
    from livekit.plugins import openai as lk_openai  # only needed for LIVEKIT_EN_STT=openai
except ImportError:
    lk_openai = None

from chatterbox_tts import ChatterboxTTS
from indic_clients import IndicAsr, IndicTts

AUDIO_IN_RATE = 16000    # Node downsamples the browser mic to 16 kHz before sending
AUDIO_OUT_RATE = 24000   # what the browser's playback AudioContext expects
OUT_CHUNK_BYTES = 1920   # ~40 ms of PCM16 @24 kHz per wire chunk (Node re-coalesces anyway)

TAG_AUDIO = 0x01
TAG_CONTROL = 0x02

INDIC_LANGS = ("te-IN", "hi-IN")

# How the English (OpenAI) voice should be delivered — steers gpt-4o-mini-tts toward a warm,
# human, unhurried nurse rather than a flat/robotic reader. Overridable via env.
NATURAL_EN_TTS_INSTRUCTIONS = (
    "Speak like a warm, caring human nurse gently talking with a patient before they see the "
    "doctor. Natural, unhurried and conversational — soft, calm and reassuring, with real warmth. "
    "Vary your intonation like a real person; never flat, clipped or robotic. Sound genuinely "
    "present and empathetic, as if you truly care how they are feeling."
)


def _clamp_env_float(name: str, default: float, lo: float, hi: float) -> float:
    """Read a float tuning knob from the environment, falling back to `default` and clamping
    to [lo, hi] so a stray value can never make the Sarvam plugin raise a ValueError."""
    try:
        val = float((os.getenv(name) or "").strip())
    except (TypeError, ValueError):
        val = default
    return max(lo, min(hi, val))


def _vad_min_silence() -> float:
    """Seconds of quiet before the agent decides the patient has FINISHED and takes its turn.
    Silero's 0.55s default makes the agent jump in on a brief mid-thought pause, so a patient who
    pauses and then CONTINUES gets cut off / isn't heard. A longer window lets them keep talking
    through natural pauses before the agent responds. Tune with LIVEKIT_VAD_SILENCE (seconds)."""
    return _clamp_env_float("LIVEKIT_VAD_SILENCE", 0.9, 0.3, 3.0)


def _sarvam_prosody() -> dict:
    """Natural, warm delivery for Sarvam Bulbul (Telugu/Hindi), env-tunable so the voice can be
    adjusted by ear without code changes. A slightly slow pace + a little temperature make the
    nurse sound unhurried and human instead of clipped. (On bulbul:v3 pitch/loudness are ignored
    by the API — pace + temperature carry the feel.)"""
    return {
        "model": (os.getenv("SARVAM_TTS_MODEL") or "bulbul:v3").strip() or "bulbul:v3",
        "pace": _clamp_env_float("SARVAM_TTS_PACE", 0.9, 0.3, 3.0),
        "temperature": _clamp_env_float("SARVAM_TTS_TEMPERATURE", 0.7, 0.01, 2.0),
    }


# ── Intake tools — mirror LiveKitProvider.getFunctionTools() (Node persists the results) ──
def _tools() -> list:
    return [
        {
            "type": "function",
            "function": {
                "name": "red_flag_detected",
                "description": (
                    "ALERT IMMEDIATE CLINICAL ATTENTION REQUIRED: the patient reported critical "
                    "symptoms that need immediate medical review"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "symptoms": {"type": "array", "items": {"type": "string"},
                                     "description": "List of critical symptoms mentioned by the patient"},
                        "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"]},
                    },
                    "required": ["symptoms", "severity"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "end_session",
                "description": "End the intake when the patient consents or the intake is complete.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "consent_given": {"type": "boolean"},
                        "reason": {"type": "string",
                                   "enum": ["intake_complete", "patient_request", "patient_uncomfortable", "timeout"]},
                    },
                    "required": ["consent_given", "reason"],
                },
            },
        },
    ]


def _build_stt(lang: str):
    """Sarvam Saarika STT for every language by default (English included — matches the
    in-house/pipecat lesson that Sarvam STT is the reliable path here). Opt English back to
    OpenAI with LIVEKIT_EN_STT=openai."""
    if lang == "en-IN" and os.getenv("LIVEKIT_EN_STT", "sarvam").strip().lower() == "openai":
        if lk_openai is None:
            raise RuntimeError("livekit-plugins-openai not installed but LIVEKIT_EN_STT=openai")
        return lk_openai.STT(model=os.getenv("OPENAI_STT_MODEL", "gpt-4o-transcribe"))
    if not SARVAM_AVAILABLE:
        raise RuntimeError("livekit-plugins-sarvam is not installed — run: pip install livekit-plugins-sarvam")
    if not os.getenv("SARVAM_API_KEY"):
        raise RuntimeError("SARVAM_API_KEY is required for the STT stage")
    try:
        return sarvam.STT(language=lang)
    except TypeError:
        return sarvam.STT()  # older/newer signature — fall back to default + auto language


def _build_sarvam_tts(lang: str, voice: str):
    """Sarvam Bulbul TTS for Telugu/Hindi, tuned for a warm, natural, unhurried delivery.
    Constructor kwargs vary across plugin versions AND a speaker can be incompatible with the
    chosen model (raises ValueError), so try the richest form and degrade gracefully — first
    dropping the tuning, then falling back to a known warm v3 speaker (`neha`), then bare
    defaults. Sarvam synthesises directly at the browser playback rate (24 kHz), no resample."""
    if not SARVAM_AVAILABLE:
        raise RuntimeError("livekit-plugins-sarvam is not installed — run: pip install livekit-plugins-sarvam")
    v = (voice or "").strip() or "neha"
    ssr = AUDIO_OUT_RATE
    prosody = _sarvam_prosody()
    attempts: list[dict] = []
    # Prefer the requested voice; if it can't be built (e.g. a v2-only speaker against v3),
    # retry with the warm default `neha` before giving up on the natural tuning entirely.
    for spk in (v, "neha"):
        attempts.append({"target_language_code": lang, "speaker": spk, "speech_sample_rate": ssr, **prosody})
        attempts.append({"target_language_code": lang, "speaker": spk, "speech_sample_rate": ssr})
        attempts.append({"target_language_code": lang, "speaker": spk})
    attempts.append({"target_language_code": lang})
    attempts.append({})
    for kwargs in attempts:
        try:
            return sarvam.TTS(**kwargs)
        except (TypeError, ValueError):
            continue
    return sarvam.TTS()


def _build_openai_tts():
    """OpenAI TTS via the LiveKit plugin — the fast/cloud English voice, used when Chatterbox
    is unavailable or LIVEKIT_EN_TTS=openai (no GPU needed). `instructions` steer gpt-4o-mini-tts
    toward a warm, natural, human delivery; degrade gracefully on older plugin signatures."""
    if lk_openai is None:
        raise RuntimeError("livekit-plugins-openai is not installed — run: pip install livekit-plugins-openai")
    model = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    voice = os.getenv("OPENAI_TTS_VOICE", "coral")
    instructions = (os.getenv("OPENAI_TTS_INSTRUCTIONS") or NATURAL_EN_TTS_INSTRUCTIONS).strip()
    for kwargs in (
        {"model": model, "voice": voice, "instructions": instructions},
        {"model": model, "voice": voice},
        {"voice": voice},
        {},
    ):
        try:
            return lk_openai.TTS(**kwargs)
        except TypeError:
            continue
    return lk_openai.TTS()


class Session:
    """Runs one intake conversation over the given (already-accepted) FastAPI websocket."""

    def __init__(self, websocket, cfg: dict):
        self.ws = websocket
        self.session_id = str(cfg.get("session_id", "unknown"))
        self.lang = str(cfg.get("language") or "te-IN")
        self.system_prompt = str(cfg.get("system_prompt") or
                                 "You are a warm medical intake assistant. Ask one short question at a time.")
        self.voice = str(cfg.get("voice") or "")
        try:
            self.temperature = float(cfg.get("temperature", 0.6))
        except (TypeError, ValueError):
            self.temperature = 0.6

        # English TTS preference: "chatterbox" (default; falls back to OpenAI if unreachable)
        # or "openai" (skip Chatterbox — fast, no GPU). Resolved in start(); te/hi always Sarvam.
        self.en_tts_pref = os.getenv("LIVEKIT_EN_TTS", "chatterbox").strip().lower()
        self.tts_engine = "sarvam"  # final value set in start()
        # Per-language engine choices from Settings (Node forwards engineMap). For te/hi we honour
        # the STT (sarvam | indic-conformer | indic-whisper) and TTS (sarvam | parler) selection;
        # Sarvam is the default + runtime fallback if the indic-voice-service isn't reachable.
        _lang_map = (cfg.get("engine_map") or {}).get(self.lang) or {}
        self.te_stt_engine = str(_lang_map.get("stt") or "sarvam").strip().lower()
        self.te_tts_engine = str(_lang_map.get("tts") or "sarvam").strip().lower()
        self.messages = [{"role": "system", "content": self.system_prompt}]
        self.tools = _tools()

        self._send_lock = asyncio.Lock()
        self._openai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))
        self._llm_model = os.getenv("LIVEKIT_LLM_MODEL", "gpt-4o")

        # Built in start()
        self._vad = None
        self._vad_stream = None
        self._stt = None
        self._sarvam_tts = None
        self._openai_tts = None
        self._chatterbox = None
        self._indic_asr = None   # IndicConformer/IndicWhisper client (te/hi, optional)
        self._indic_tts = None   # Indic Parler-TTS client (te/hi, optional)

        self.bot_speaking = False
        self.turn_task: asyncio.Task | None = None
        self.stopped = False

    # ── wire helpers ──────────────────────────────────────────────────────────────
    async def emit(self, obj: dict):
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass  # socket already closing — Node handles teardown

    async def send_audio(self, pcm: bytes):
        if not pcm:
            return
        try:
            async with self._send_lock:
                for i in range(0, len(pcm), OUT_CHUNK_BYTES):
                    await self.ws.send_bytes(pcm[i:i + OUT_CHUNK_BYTES])
        except Exception:
            pass

    # ── setup ─────────────────────────────────────────────────────────────────────
    async def start(self):
        self._stt = _build_stt(self.lang)   # Sarvam for te/hi (also the fallback for Indic STT)
        if self.lang != "en-IN":
            # Telugu/Hindi: Sarvam is the default + runtime fallback. Optionally use the open Indic
            # models (indic-voice-service) for STT and/or TTS, per the Settings engine map.
            self._sarvam_tts = _build_sarvam_tts(self.lang, self.voice)
            if self.te_stt_engine in ("indic-conformer", "indic-whisper"):
                self._indic_asr = IndicAsr()
                logger.info(f"{self.lang} STT: {self.te_stt_engine} (indic-voice-service) — Sarvam fallback")
            if self.te_tts_engine == "parler":
                self._indic_tts = IndicTts(voice=self.voice)
                self.tts_engine = "parler"
                logger.info(f"{self.lang} TTS: Indic Parler-TTS (indic-voice-service) — Sarvam fallback")
            else:
                self.tts_engine = "sarvam"
        else:
            # English: Chatterbox-Turbo preferred, OpenAI TTS as the fast/reliable fallback so an
            # unreachable (or unset) Chatterbox server no longer hard-fails the session.
            self._openai_tts = _build_openai_tts()
            if self.en_tts_pref == "openai":
                self.tts_engine = "openai"
                logger.info("English TTS: OpenAI (LIVEKIT_EN_TTS=openai)")
            else:
                self._chatterbox = ChatterboxTTS()
                if await self._chatterbox.health():
                    self.tts_engine = "chatterbox"
                    logger.info(f"English TTS: Chatterbox-Turbo ({self._chatterbox.base_url})")
                else:
                    logger.warning(
                        f"Chatterbox not reachable at {self._chatterbox.base_url} — English falling "
                        "back to OpenAI TTS. (Set LIVEKIT_EN_TTS=openai to skip the check, or start "
                        "the Chatterbox-TTS-Server for the Chatterbox voice.)"
                    )
                    await self._chatterbox.aclose()
                    self._chatterbox = None
                    self.tts_engine = "openai"
        # Give the patient room to pause and CONTINUE before the agent takes the turn (see
        # _vad_min_silence). Degrade gracefully if an older plugin lacks the kwarg.
        try:
            self._vad = silero.VAD.load(min_silence_duration=_vad_min_silence())
        except TypeError:
            self._vad = silero.VAD.load()
        self._vad_stream = self._vad.stream()

    async def run(self):
        await self.emit({"type": "ready"})
        await asyncio.gather(self._recv_loop(), self._vad_loop())

    # ── Node → here: mic audio + control ───────────────────────────────────────────
    async def _recv_loop(self):
        while not self.stopped:
            try:
                msg = await self.ws.receive()
            except Exception:
                break
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is not None and len(data) >= 1:
                tag = data[0]
                if tag == TAG_AUDIO:
                    self._push_audio(bytes(data[1:]))
                elif tag == TAG_CONTROL:
                    try:
                        await self._on_control(json.loads(bytes(data[1:]).decode("utf-8")))
                    except Exception as e:
                        logger.warning(f"bad control: {e}")
                continue
            text = msg.get("text")
            if text:  # tolerate JSON control sent as text
                try:
                    await self._on_control(json.loads(text))
                except Exception:
                    pass
        await self._shutdown()

    def _push_audio(self, pcm16: bytes):
        if not pcm16 or self._vad_stream is None:
            return
        frame = rtc.AudioFrame(
            data=pcm16, sample_rate=AUDIO_IN_RATE, num_channels=1,
            samples_per_channel=len(pcm16) // 2,
        )
        try:
            self._vad_stream.push_frame(frame)
        except Exception as e:
            logger.warning(f"vad push failed: {e}")

    async def _on_control(self, msg: dict):
        t = msg.get("type")
        if t == "go":
            self._start_turn(user_frames=None)     # greet
        elif t == "interrupt":
            self._cancel_turn()
        elif t == "end":
            self.stopped = True
            self._cancel_turn()

    # ── VAD: endpointing + barge-in ────────────────────────────────────────────────
    async def _vad_loop(self):
        try:
            async for ev in self._vad_stream:
                if ev.type == vad_mod.VADEventType.START_OF_SPEECH:
                    await self.emit({"type": "user_started_speaking"})
                    if self.bot_speaking:
                        self._cancel_turn()            # patient talked over the agent
                elif ev.type == vad_mod.VADEventType.END_OF_SPEECH:
                    await self.emit({"type": "user_stopped_speaking"})
                    frames = getattr(ev, "frames", None)
                    if frames:
                        self._start_turn(user_frames=frames)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"vad loop ended: {e}")

    # ── turn orchestration ─────────────────────────────────────────────────────────
    def _cancel_turn(self):
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.bot_speaking = False

    def _start_turn(self, user_frames):
        # A new turn supersedes whatever the bot was doing (greeting or a stale reply).
        self._cancel_turn()
        self.turn_task = asyncio.create_task(self._run_turn(user_frames))

    async def _run_turn(self, user_frames):
        try:
            if user_frames is not None:
                text = await self._transcribe(user_frames)
                if not text:
                    return
                await self.emit({"type": "user_transcript", "text": text})
                self.messages.append({"role": "user", "content": text})

            reply = await self._llm_reply()
            if not reply:
                return

            self.bot_speaking = True
            await self.emit({"type": "bot_started_speaking"})
            async for pcm in self._synthesize(reply):
                await self.send_audio(pcm)
            await self.emit({"type": "bot_transcript", "text": reply})
            self.messages.append({"role": "assistant", "content": reply})
        except asyncio.CancelledError:
            pass  # barge-in / interrupt — Node already told the browser to stop
        except Exception as e:
            logger.exception(f"turn failed: {e}")
            await self.emit({"type": "error", "message": f"voice turn failed: {e}"})
        finally:
            if self.bot_speaking:
                self.bot_speaking = False
                await self.emit({"type": "bot_stopped_speaking"})

    async def _transcribe(self, frames) -> str:
        # Indic STT (te/hi) via the indic-voice-service, with Sarvam fallback.
        if self._indic_asr is not None:
            try:
                text = await self._indic_asr.transcribe(frames, self.lang, self.te_stt_engine)
                if text:
                    return text
            except Exception as e:
                logger.warning(f"Indic STT ({self.te_stt_engine}) failed ({e}); falling back to Sarvam")
        try:
            ev = await self._stt.recognize(frames)
            alts = getattr(ev, "alternatives", None)
            if alts:
                return (alts[0].text or "").strip()
        except Exception as e:
            logger.warning(f"stt failed: {e}")
        return ""

    async def _llm_reply(self) -> str:
        """One assistant turn. If the model calls tools, forward each to Node (which owns the
        effect), feed a trivial result back, and ask once more for the spoken reply."""
        resp = await self._openai.chat.completions.create(
            model=self._llm_model, messages=self.messages, tools=self.tools,
            tool_choice="auto", temperature=self.temperature, max_tokens=200,
        )
        msg = resp.choices[0].message
        if msg.tool_calls:
            self.messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                await self.emit({"type": "tool_call", "name": tc.function.name, "arguments": args})
                self.messages.append({"role": "tool", "tool_call_id": tc.id,
                                      "content": json.dumps({"ok": True})})
            resp = await self._openai.chat.completions.create(
                model=self._llm_model, messages=self.messages, tools=self.tools,
                tool_choice="auto", temperature=self.temperature, max_tokens=200,
            )
            msg = resp.choices[0].message
        return (msg.content or "").strip()

    async def _synthesize(self, text: str):
        """Yield PCM16 mono @24 kHz for `text` from the resolved engine. If a Chatterbox synth
        fails (server down mid-session, timeout, etc.) fall back to OpenAI TTS for that turn so a
        reply is never lost on TTS."""
        if self.tts_engine == "chatterbox":
            try:
                pcm = await self._chatterbox.synthesize(text)
                if not pcm:
                    raise RuntimeError("Chatterbox returned no audio")
                yield pcm
                return
            except Exception as e:
                logger.warning(f"Chatterbox synth failed ({e}); falling back to OpenAI TTS for this turn")
                async for chunk in self._lk_tts_stream(self._openai_tts, text):
                    yield chunk
                return
        if self.tts_engine == "parler":
            try:
                pcm = await self._indic_tts.synthesize(text, self.lang)
                if not pcm:
                    raise RuntimeError("Indic Parler-TTS returned no audio")
                yield pcm
                return
            except Exception as e:
                logger.warning(f"Indic Parler-TTS failed ({e}); falling back to Sarvam for this turn")
                async for chunk in self._lk_tts_stream(self._sarvam_tts, text):
                    yield chunk
                return
        tts = self._openai_tts if self.tts_engine == "openai" else self._sarvam_tts
        async for chunk in self._lk_tts_stream(tts, text):
            yield chunk

    async def _lk_tts_stream(self, tts, text: str):
        """Iterate a LiveKit tts.TTS `.synthesize()` stream → PCM16 @24 kHz (resample if needed)."""
        stream = tts.synthesize(text)
        async for a in stream:
            frame = a.frame
            data = bytes(frame.data)
            if getattr(frame, "sample_rate", AUDIO_OUT_RATE) != AUDIO_OUT_RATE:
                data = _resample_pcm16(data, frame.sample_rate, AUDIO_OUT_RATE)
            yield data

    async def _shutdown(self):
        self.stopped = True
        self._cancel_turn()
        try:
            if self._vad_stream is not None:
                await self._vad_stream.aclose()
        except Exception:
            pass
        if self._chatterbox is not None:
            await self._chatterbox.aclose()
        if self._indic_asr is not None:
            await self._indic_asr.aclose()
        if self._indic_tts is not None:
            await self._indic_tts.aclose()


def _resample_pcm16(pcm: bytes, in_rate: int, out_rate: int) -> bytes:
    if in_rate == out_rate or not pcm:
        return pcm
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    out_len = int(round(samples.size * out_rate / float(in_rate)))
    if out_len <= 0:
        return b""
    xp = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    x = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
    out = np.interp(x, xp, samples)
    return np.clip(out, -32768.0, 32767.0).astype(np.int16).tobytes()


async def run_bot(websocket, cfg: dict):
    """Entry point used by main.py once the {"type":"start", ...} config has been read."""
    logger.info(f"▶ livekit session {cfg.get('session_id')} lang={cfg.get('language')} "
                f"voice={cfg.get('voice') or '(default)'}")
    session = Session(websocket, cfg)
    # The LiveKit plugins (Sarvam STT/TTS) pull a shared aiohttp session from a context the
    # agent-worker API normally sets up. We run the plugins in our own loop, so we open that
    # http context ourselves for the whole session (propagates to the turn tasks we spawn).
    async with http_context.open():
        await session.start()   # may raise → main.py reports it as an error before 'ready'
        try:
            await session.run()
        finally:
            await session._shutdown()
    logger.info(f"■ livekit session finished {session.session_id}")
