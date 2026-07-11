"""
Pipecat voice pipeline for the Pre-Consultation intake agent.
=====================================================================================
One pipeline per session, driven over a single WebSocket by the Node backend's
PipecatProvider. The Node side owns ALL business logic (DB writes, red-flag
persistence, session lifecycle, frontend contract); this service is a pure
open-source voice loop: VAD → STT → LLM (+tools) → TTS.

── Bridge protocol (Node ⇆ this service) ───────────────────────────────────────
Node → Python (all BINARY, 1-byte tag prefix):
    0x01 + PCM16LE mono @16kHz     microphone audio
    0x02 + UTF-8 JSON              control: {"type":"go"|"interrupt"|"end"}
  (The very first message on the socket is TEXT — the {"type":"start", ...}
   session config — handled by main.py before the transport takes over.)

Python → Node:
    BINARY  raw PCM16LE mono @24kHz          agent TTS audio (no prefix)
    TEXT    JSON events:
        {"type":"ready"}
        {"type":"user_started_speaking"} / {"type":"user_stopped_speaking"}
        {"type":"user_transcript","text":...}
        {"type":"bot_started_speaking"} / {"type":"bot_stopped_speaking"}
        {"type":"bot_transcript","text":...}
        {"type":"tool_call","name":...,"arguments":{...}}
        {"type":"error","message":...}

Engines (reusing the project's existing keys):
    te-IN / hi-IN : Sarvam STT (saaras) + Sarvam TTS (bulbul) + OpenAI gpt-4o LLM
                    (LLM switchable to Sarvam's OpenAI-compatible API via env)
    en-IN         : OpenAI STT + OpenAI LLM + OpenAI TTS
"""

import asyncio
import json
import os
import re

from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMRunFrame,
    OutputAudioRawFrame,
    StartFrame,
    TranscriptionFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy

# The transport module moved between pipecat releases; support both paths.
try:
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )
except ImportError:  # older pipecat
    from pipecat.transports.network.fastapi_websocket import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

# Sarvam services ship in the [sarvam] extra; only required for te/hi sessions.
try:
    from pipecat.services.sarvam.stt import SarvamSTTService
    from pipecat.services.sarvam.tts import SarvamTTSService

    SARVAM_AVAILABLE = True
except ImportError:
    SARVAM_AVAILABLE = False

AUDIO_IN_RATE = 16000   # Node downsamples the browser mic to 16 kHz before sending
AUDIO_OUT_RATE = 24000  # what the browser's playback AudioContext expects

# Optional diagnostics, read once (avoid a getenv per audio frame). Set to 1 to enable.
DEBUG_AUDIO = bool(os.getenv("PIPECAT_DEBUG_AUDIO"))
DEBUG_FRAMES = bool(os.getenv("PIPECAT_DEBUG_FRAMES"))

TAG_AUDIO = 0x01
TAG_CONTROL = 0x02

INDIC_LANGS = ("te-IN", "hi-IN")

# Sarvam bulbul speakers by model generation — used to pick a model that matches the
# configured voice (a v2-only voice on bulbul:v3 would be rejected by the API).
SARVAM_V3_VOICES = {"ritu", "priya", "neha", "shreya", "pooja", "aditya", "rahul"}
SARVAM_V2_VOICES = {"anushka", "vidya", "manisha", "abhilash", "karun", "arya", "hitesh"}
DEFAULT_SARVAM_VOICE = "neha"

OPENAI_TTS_VOICES = {"alloy", "echo", "shimmer", "marin", "cedar", "ash", "coral", "sage", "verse", "ballad", "fable", "onyx", "nova"}
DEFAULT_OPENAI_VOICE = "coral"


def _interruption_frame():
    """Frame that forces the pipeline to abort the bot's current turn. The class was
    renamed across pipecat versions (BotInterruptionFrame → InterruptionTaskFrame →
    InterruptionWorkerFrame), so resolve the newest available one at call time."""
    for name in ("InterruptionWorkerFrame", "InterruptionTaskFrame", "BotInterruptionFrame"):
        try:
            import pipecat.frames.frames as frames_mod

            cls = getattr(frames_mod, name, None)
            if cls:
                return cls()
        except Exception:
            continue
    logger.warning("No interruption frame class available in this pipecat version")
    return None


class BridgeSerializer(FrameSerializer):
    """Speaks the Node bridge protocol: tagged binary in, raw PCM out.

    JSON *events* to Node are sent as TEXT directly by the pipeline's relays (not
    through this serializer), so binary from this serializer is always pure audio."""

    def __init__(self, on_control):
        super().__init__()
        self._on_control = on_control
        self._audio_frames = 0
        self._audio_bytes = 0

    async def setup(self, frame: StartFrame):
        pass

    async def serialize(self, frame: Frame):
        if isinstance(frame, OutputAudioRawFrame):
            return bytes(frame.audio)
        return None

    async def deserialize(self, data):
        if isinstance(data, (bytes, bytearray)):
            if len(data) < 2:
                return None
            tag, payload = data[0], bytes(data[1:])
            if tag == TAG_AUDIO:
                if DEBUG_AUDIO:
                    self._audio_frames += 1
                    self._audio_bytes += len(payload)
                    if self._audio_frames % 50 == 0:
                        logger.info(f"[audio-in] {self._audio_frames} frames, {self._audio_bytes} bytes")
                return InputAudioRawFrame(
                    audio=payload, sample_rate=AUDIO_IN_RATE, num_channels=1
                )
            if tag == TAG_CONTROL:
                try:
                    await self._on_control(json.loads(payload.decode("utf-8")))
                except Exception as e:
                    logger.warning(f"Bad control message: {e}")
            return None
        # Text after the start handshake: tolerate JSON control for robustness.
        try:
            await self._on_control(json.loads(data))
        except Exception:
            pass
        return None


class UserEventRelay(FrameProcessor):
    """Sits right after STT: reports the patient's speech activity and final transcripts."""

    def __init__(self, emit):
        super().__init__()
        self._emit = emit

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if DEBUG_FRAMES and direction == FrameDirection.DOWNSTREAM:
            n = type(frame).__name__
            if n not in ("InputAudioRawFrame", "OutputAudioRawFrame", "TTSAudioRawFrame", "BotSpeakingFrame"):
                logger.info(f"[user-relay] {n}")
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TranscriptionFrame) and frame.text and frame.text.strip():
                await self._emit({"type": "user_transcript", "text": frame.text.strip()})
            elif isinstance(frame, UserStartedSpeakingFrame):
                await self._emit({"type": "user_started_speaking"})
            elif isinstance(frame, UserStoppedSpeakingFrame):
                await self._emit({"type": "user_stopped_speaking"})
        await self.push_frame(frame, direction)


def _join_spoken(parts):
    text = " ".join(p.strip() for p in parts if p and p.strip())
    text = re.sub(r"\s+([,.!?;:…])", r"\1", text)
    return re.sub(r"\s{2,}", " ", text).strip()


class BotEventRelay(FrameProcessor):
    """Sits after transport.output(): reports the agent's spoken turns.

    Frame order past the output transport is: TTSTextFrame(s) (sentence-level, pushed as
    the TTS synthesises) → BotStartedSpeakingFrame → audio → BotStoppedSpeakingFrame. So
    text is accumulated independently of the speaking window and flushed on the stop
    event. Only TTSTextFrames are collected — each sentence ALSO passes as a plain
    AggregatedTextFrame, which would duplicate the text."""

    def __init__(self, emit):
        super().__init__()
        self._emit = emit
        self._parts = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            await self._emit({"type": "bot_started_speaking"})
        elif isinstance(frame, TTSTextFrame):
            if frame.text:
                self._parts.append(frame.text)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            text = _join_spoken(self._parts)
            self._parts = []
            if text:
                await self._emit({"type": "bot_transcript", "text": text})
            await self._emit({"type": "bot_stopped_speaking"})
        await self.push_frame(frame, direction)


# ── Engine builders (reuse the project's existing OpenAI + Sarvam keys) ─────────
def _build_stt(lang: str):
    """Speech-to-text. Sarvam streaming STT is used for ALL languages by default —
    including English (saaras:v3 supports en-IN). It runs its own VAD over a persistent
    socket, so it reliably produces transcripts. OpenAI's STT is *segmented* (it depends
    on the transport's VAD to slice utterances) and in this WS-bridge setup it produced
    NO transcripts for English — the agent never heard the patient. Set PIPECAT_EN_STT=
    openai to opt back into OpenAI STT for English if you specifically want it."""
    use_openai_en = lang == "en-IN" and os.getenv("PIPECAT_EN_STT", "sarvam").strip().lower() == "openai"
    if use_openai_en:
        return OpenAISTTService(
            api_key=os.getenv("OPENAI_API_KEY", ""),
            model=os.getenv("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
        )

    if not SARVAM_AVAILABLE:
        raise RuntimeError("pipecat [sarvam] extra is not installed — run: pip install 'pipecat-ai[sarvam]'")
    key = os.getenv("SARVAM_API_KEY", "")
    if not key:
        raise RuntimeError("SARVAM_API_KEY is required for the STT stage")
    # Pin the language (matches the in-house provider's proven saaras config) rather than
    # relying on saaras:v3 auto-detect. Settings-based construction is the non-deprecated
    # path (top-level model= is deprecated in pipecat ≥0.0.105).
    return SarvamSTTService(
        api_key=key,
        mode="transcribe",
        settings=SarvamSTTService.Settings(
            model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            language=lang,
        ),
    )


def _build_tts(lang: str, voice: str):
    if lang in INDIC_LANGS:
        key = os.getenv("SARVAM_API_KEY", "")
        v = (voice or "").strip().lower()
        if v in SARVAM_V3_VOICES:
            model = "bulbul:v3"
        elif v in SARVAM_V2_VOICES:
            model = "bulbul:v2"
        else:
            v, model = DEFAULT_SARVAM_VOICE, "bulbul:v3"
        model = os.getenv("SARVAM_TTS_MODEL", model)
        # Settings-based construction only (top-level model=/voice_id= are deprecated in
        # pipecat ≥0.0.105); language is a plain string here — resolve_language() passes
        # "te-IN"/"hi-IN" through unchanged to Sarvam's language_code.
        return SarvamTTSService(
            api_key=key,
            sample_rate=AUDIO_OUT_RATE,
            settings=SarvamTTSService.Settings(voice=v, model=model, language=lang),
        )
    v = (voice or "").strip().lower()
    if v not in OPENAI_TTS_VOICES:
        v = DEFAULT_OPENAI_VOICE
    return OpenAITTSService(
        api_key=os.getenv("OPENAI_API_KEY", ""),
        voice=v,
        model=os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
        sample_rate=AUDIO_OUT_RATE,
    )


def _build_llm(lang: str, temperature: float):
    engine = os.getenv("PIPECAT_LLM_ENGINE", "openai").strip().lower()
    if engine == "sarvam" and lang in INDIC_LANGS:
        # Sarvam's chat API is OpenAI-compatible, so the OpenAI service drives it too.
        return OpenAILLMService(
            api_key=os.getenv("SARVAM_API_KEY", ""),
            base_url="https://api.sarvam.ai/v1",
            model=os.getenv("SARVAM_CHAT_MODEL", "sarvam-m"),
            params=OpenAILLMService.InputParams(temperature=temperature),
        )
    return OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY", ""),
        model=os.getenv("OPENAI_LLM_MODEL", "gpt-4o"),
        params=OpenAILLMService.InputParams(temperature=temperature),
    )


def _tools_schema() -> ToolsSchema:
    # Mirrors backend/src/providers getFunctionTools() — the Node side persists the results.
    red_flag = FunctionSchema(
        name="red_flag_detected",
        description=(
            "ALERT IMMEDIATE CLINICAL ATTENTION REQUIRED: the patient reported critical "
            "symptoms that need immediate medical review"
        ),
        properties={
            "symptoms": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of critical symptoms mentioned by the patient",
            },
            "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"]},
        },
        required=["symptoms", "severity"],
    )
    end_session = FunctionSchema(
        name="end_session",
        description="End the intake when the patient consents or the intake is complete.",
        properties={
            "consent_given": {"type": "boolean"},
            "reason": {
                "type": "string",
                "enum": ["intake_complete", "patient_request", "patient_uncomfortable", "timeout"],
            },
        },
        required=["consent_given", "reason"],
    )
    return ToolsSchema(standard_tools=[red_flag, end_session])


async def run_bot(websocket, cfg: dict):
    """Run one voice session over an already-accepted FastAPI websocket. `cfg` is the
    parsed {"type":"start", ...} message from the Node backend."""
    session_id = str(cfg.get("session_id", "unknown"))
    lang = str(cfg.get("language") or "te-IN")
    system_prompt = str(cfg.get("system_prompt") or "You are a warm medical intake assistant. Ask one short question at a time.")
    voice = str(cfg.get("voice") or "")
    try:
        temperature = float(cfg.get("temperature", 0.6))
    except (TypeError, ValueError):
        temperature = 0.6

    logger.info(f"▶ pipecat session {session_id} lang={lang} voice={voice or '(default)'}")

    send_lock = asyncio.Lock()

    async def emit(obj: dict):
        try:
            async with send_lock:
                await websocket.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass  # socket already closing — Node handles teardown

    holder: dict = {}

    async def on_control(msg: dict):
        task: PipelineTask | None = holder.get("task")
        if not task:
            return
        t = msg.get("type")
        if t == "go":
            # Frontend is now listening — run the LLM once on the system prompt so the
            # agent greets the patient first.
            await task.queue_frames([LLMRunFrame()])
        elif t == "interrupt":
            frame = _interruption_frame()
            if frame:
                await task.queue_frame(frame)
        elif t == "end":
            await task.queue_frame(EndFrame())

    serializer = BridgeSerializer(on_control)
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.6)),
            serializer=serializer,
            session_timeout=60 * 30,
        ),
    )

    stt = _build_stt(lang)
    tts = _build_tts(lang, voice)
    llm = _build_llm(lang, temperature)

    async def on_red_flag(params: FunctionCallParams):
        await emit({"type": "tool_call", "name": "red_flag_detected", "arguments": params.arguments or {}})
        await params.result_callback({"ok": True, "alerted": True})

    async def on_end_session(params: FunctionCallParams):
        await emit({"type": "tool_call", "name": "end_session", "arguments": params.arguments or {}})
        await params.result_callback({"ok": True, "ending": True})

    llm.register_function("red_flag_detected", on_red_flag)
    llm.register_function("end_session", on_end_session)

    context = LLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=_tools_schema(),
    )
    # Turn-taking: pipecat's default stop strategy runs an ONNX "Smart Turn" model on the
    # CPU after every utterance to decide if the patient is done — that added ~1s+ of
    # latency per reply. For a straightforward intake Q&A, a plain VAD-silence timer is
    # snappier and plenty accurate. Set PIPECAT_SMART_TURN=1 to restore the ML detector.
    user_params = None
    if os.getenv("PIPECAT_SMART_TURN", "").strip() not in ("1", "true", "yes"):
        try:
            turn_stop_secs = float(os.getenv("PIPECAT_TURN_STOP_SECS", "0.6"))
        except ValueError:
            turn_stop_secs = 0.6
        user_params = LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=turn_stop_secs)]
            )
        )
    ctx_agg = LLMContextAggregatorPair(context, user_params=user_params) if user_params \
        else LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            UserEventRelay(emit),
            ctx_agg.user(),
            llm,
            tts,
            transport.output(),
            BotEventRelay(emit),
            ctx_agg.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=AUDIO_IN_RATE,
            audio_out_sample_rate=AUDIO_OUT_RATE,
        ),
    )
    holder["task"] = task

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info(f"◀ client disconnected, cancelling session {session_id}")
        await task.cancel()

    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(_transport, _client):
        logger.info(f"◀ session timeout {session_id}")
        await task.queue_frame(EndFrame())

    await emit({"type": "ready"})

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    finally:
        logger.info(f"■ pipecat session finished {session_id}")
