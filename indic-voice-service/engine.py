"""
Open Indic voice models — ASR (IndicConformer / IndicWhisper) + TTS (Indic Parler-TTS).
=====================================================================================
Loaded lazily (first use) so the service boots fast and only pulls the model that's actually
requested. Device is auto (CUDA if available, else CPU). These are heavy, GPU-preferred models
— on CPU they run but are slow (esp. Parler-TTS), which is why the livekit-service keeps Sarvam
as its default + fallback.

NOTE: written against the documented HF model APIs (ai4bharat/indic-conformer-600m-multilingual,
ai4bharat/indic-parler-tts, IndicWhisper checkpoints). As with the other services in this repo,
do a short finalize pass on the GPU host — model call signatures occasionally shift between
transformers / parler-tts releases (wrapped defensively where they vary).
"""

import io
import os
import threading

import numpy as np
import soundfile as sf
from loguru import logger

# Per-language IndicWhisper checkpoints (override via env). IndicConformer is one multilingual
# model for all 22 languages, so it needs no per-language map.
INDIC_WHISPER_MODELS = {
    "te-IN": os.getenv("INDIC_WHISPER_TE", "vasista22/whisper-telugu-medium"),
    "hi-IN": os.getenv("INDIC_WHISPER_HI", "vasista22/whisper-hindi-medium"),
}
CONFORMER_MODEL = os.getenv("INDIC_CONFORMER_MODEL", "ai4bharat/indic-conformer-600m-multilingual")
PARLER_MODEL = os.getenv("INDIC_PARLER_MODEL", "ai4bharat/indic-parler-tts")

_lock = threading.Lock()
_device = None
_conformer = None
_whisper: dict = {}
_parler = None  # (model, prompt_tokenizer, description_tokenizer)


def device() -> str:
    global _device
    if _device is None:
        import torch
        pref = os.getenv("INDIC_DEVICE", "auto").strip().lower()
        if pref == "cpu":
            _device = "cpu"
        elif torch.cuda.is_available():
            _device = "cuda:0"
        else:
            _device = "cpu"
        logger.info(f"indic-voice device: {_device}")
    return _device


def _lang2(code: str) -> str:
    return (code or "te-IN").split("-")[0].lower()   # "te-IN" -> "te"


def _wav_to_mono16k(wav_bytes: bytes):
    """Decode WAV bytes → float32 mono @16 kHz (numpy)."""
    data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    if sr != 16000 and data.size:
        n = int(round(len(data) * 16000 / sr))
        xp = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
        x = np.linspace(0.0, 1.0, num=n, endpoint=False)
        data = np.interp(x, xp, data).astype("float32")
    return np.asarray(data, dtype="float32")


# ── ASR ──────────────────────────────────────────────────────────────────────
def transcribe(wav_bytes: bytes, language: str, engine: str) -> str:
    if engine == "indic-whisper":
        return _whisper_transcribe(wav_bytes, language)
    return _conformer_transcribe(wav_bytes, language)   # default: indic-conformer


def _conformer_transcribe(wav_bytes: bytes, language: str) -> str:
    global _conformer
    with _lock:
        if _conformer is None:
            from transformers import AutoModel
            logger.info(f"Loading IndicConformer ({CONFORMER_MODEL})…")
            _conformer = AutoModel.from_pretrained(CONFORMER_MODEL, trust_remote_code=True).to(device())
            logger.info("IndicConformer loaded")
    import torch
    data = _wav_to_mono16k(wav_bytes)
    wav = torch.tensor(data).unsqueeze(0).to(device())
    decoding = os.getenv("INDIC_CONFORMER_DECODING", "ctc")   # "ctc" (fast) or "rnnt"
    out = _conformer(wav, _lang2(language), decoding)
    return (out if isinstance(out, str) else str(out)).strip()


def _whisper_transcribe(wav_bytes: bytes, language: str) -> str:
    model_id = INDIC_WHISPER_MODELS.get(language) or INDIC_WHISPER_MODELS.get(f"{_lang2(language)}-IN") \
        or "vasista22/whisper-telugu-medium"
    with _lock:
        if model_id not in _whisper:
            from transformers import pipeline
            dev = 0 if device().startswith("cuda") else -1
            logger.info(f"Loading IndicWhisper ({model_id})…")
            _whisper[model_id] = pipeline("automatic-speech-recognition", model=model_id, device=dev)
            logger.info("IndicWhisper loaded")
    data = _wav_to_mono16k(wav_bytes)
    res = _whisper[model_id](data)
    text = res.get("text") if isinstance(res, dict) else res
    return str(text or "").strip()


# ── TTS (Indic Parler-TTS) ────────────────────────────────────────────────────
def _load_parler():
    global _parler
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer
    logger.info(f"Loading Indic Parler-TTS ({PARLER_MODEL})…")
    model = ParlerTTSForConditionalGeneration.from_pretrained(PARLER_MODEL).to(device())
    prompt_tok = AutoTokenizer.from_pretrained(PARLER_MODEL)
    desc_tok = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    _parler = (model, prompt_tok, desc_tok)
    logger.info("Indic Parler-TTS loaded")


def _voice_description(language: str, voice: str | None) -> str:
    # Parler-TTS is prompted with a natural-language voice description. `voice` (if given) is
    # used as the speaker name; otherwise a neutral clinical-friendly default.
    speaker = (voice or "").strip()
    who = f"{speaker} speaks" if speaker else "A female speaker delivers"
    return os.getenv(
        "INDIC_PARLER_DESCRIPTION",
        f"{who} in a clear, calm and warm voice with expressive intonation, at a natural pace, "
        f"with very close recording and no background noise.",
    )


def synthesize(text: str, language: str, voice: str | None = None) -> bytes:
    """Return WAV bytes (the client resamples to 24 kHz PCM16)."""
    global _parler
    with _lock:
        if _parler is None:
            _load_parler()
    import torch
    model, prompt_tok, desc_tok = _parler
    description = _voice_description(language, voice)
    input_ids = desc_tok(description, return_tensors="pt").input_ids.to(device())
    prompt_ids = prompt_tok(text, return_tensors="pt").input_ids.to(device())
    with torch.no_grad():
        gen = model.generate(input_ids=input_ids, prompt_input_ids=prompt_ids)
    audio = gen.cpu().numpy().squeeze().astype("float32")
    sr = int(getattr(model.config, "sampling_rate", 44100))
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def status() -> dict:
    return {
        "device_pref": os.getenv("INDIC_DEVICE", "auto"),
        "conformer_loaded": _conformer is not None,
        "whisper_loaded": list(_whisper.keys()),
        "parler_loaded": _parler is not None,
        "conformer_model": CONFORMER_MODEL,
        "parler_model": PARLER_MODEL,
    }
