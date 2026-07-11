# Voice-Clone Recording Brief (one page)

**Goal:** a 2–5 minute recording of a real person speaking **casual, conversational Telugu**
that we clone into the agent's voice. The clone can only be as human as this sample —
if the sample sounds like reading, the agent will sound like reading.

## Who to record
A warm female voice in the 25–40 range fits the "Aarogya Sahayaki" nurse persona best,
but any voice you want the agent to have works. **Written consent from the speaker is
mandatory** — keep a signed note that they agree to their voice being cloned for this
hospital assistant. (ElevenLabs also requires you to confirm consent at upload.)

## What to record — CHAT, not a script
Do **not** hand the speaker a script to read. Instead, sit with them and have a relaxed
**phone-style conversation** they barely think about. Prompt them with questions like:
- "నిన్న ఏం చేశారు? మధ్యాహ్నం ఏం తిన్నారు?" (what did you do yesterday / eat?)
- Ask them to give directions to their house from a landmark.
- Ask them to describe a relative's health visit — how it went, what the doctor said.
- Ask something that makes them **laugh once** — keep that laugh in the recording.

While they talk, the recording should naturally contain:
- **Natural fillers** — "అంటే...", "ఊఁ", "అదే మరి", "సరే సరే", little pauses and restarts.
- **Varied sentence lengths** — some 3-word answers, some long rambles.
- **One light laugh** and a few smiles you can hear.
- Normal everyday **Telugu with English words mixed in** (tablet, hospital, scan…),
  exactly how they really speak — do not ask them to "speak pure Telugu".
- Their **normal pace and volume** — no announcer voice, no slowing down.

## Technical checklist
| Item | Requirement |
|---|---|
| Length | 2–5 minutes of the SPEAKER's voice (edit out the interviewer's questions if easy; short gaps are fine) |
| Room | Quiet — no fan hum, no traffic, no other voices, no TV. Soft furnishings help (bedroom > kitchen) |
| Mic distance | 15–25 cm from the mouth, slightly off-axis (reduces breath pops) |
| Format | **WAV, mono, 16 kHz or higher** (44.1/48 kHz is fine), 16-bit+ |
| Level | Voice clearly loud, but never clipping/distorting. Do a 10-second test first and listen back |
| Phone recording? | Acceptable if in a quiet room — use a lossless/WAV recorder app, not WhatsApp voice notes (compressed) |

## What ruins a clone (re-record if any of these happen)
- Background music, TV, or a second voice talking over them
- Echoey room (bathroom/empty hall reverb)
- The speaker "performing" — announcer tone, reading rhythm, unnaturally slow
- Heavy compression (voice notes, low-bitrate MP3)

## When you're done
Save it as e.g. `voice_sample.wav` and run:

```
node backend/scripts/clone-voice.mjs --file voice_sample.wav --name "Aarogya Telugu" --engine elevenlabs
```

The script prints the new voice ID and the exact `.env` lines to activate it.
