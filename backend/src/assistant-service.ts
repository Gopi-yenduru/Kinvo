import { SarvamAIClient } from 'sarvamai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Lang } from './emergency.js';

/**
 * Assistant service — an in-app HELP bot that answers patient questions ABOUT THE APP,
 * in the patient's chosen language (English / Hindi / Telugu), by both text and voice.
 *
 * ACCURACY-FIRST DESIGN: to guarantee "no errors", the bot does NOT let the LLM freely
 * generate answers (small models hallucinate or ramble). Instead:
 *   1. The LLM is used only to CLASSIFY the question into one known topic key (an easy,
 *      reliable task), or 'medical' / 'out_of_scope'. The classifier is language-agnostic
 *      (it reads English topic descriptions and the patient's message in any language).
 *   2. The reply is a PRE-WRITTEN, verified answer for that topic, returned in the
 *      requested language — so a factual error is impossible, and medical/unknown
 *      questions are safely deferred.
 *
 * Plus speak() (TTS) and transcribe() (STT) so the help bot works by voice too. Both are
 * language-parameterised: Sarvam's bulbul (TTS) / saarika (STT) are multilingual, so only
 * the language code changes per request.
 */

const CLASSIFY_MODEL = 'sarvam-30b';
const GENERAL_MODEL = 'sarvam-30b';       // free-form answers for website/general questions
const STT_MODEL = 'saarika:v2.5';
const TTS_MODEL = 'bulbul:v2';
const TTS_SPEAKER = 'anushka';            // multilingual bulbul speaker (te/hi/en)
const DEFAULT_LANG: Lang = 'te-IN';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Normalize an incoming language value to one of the three supported codes. */
export const toLang = (v: any): Lang =>
  (v === 'hi-IN' || v === 'en-IN' || v === 'te-IN') ? v : DEFAULT_LANG;

const LANG_LABEL: Record<Lang, string> = { 'te-IN': 'Telugu', 'hi-IN': 'Hindi', 'en-IN': 'English' };

// Background the model uses to answer free-form questions about this website/app accurately.
// Keep this an accurate, complete description of the product so the bot can answer questions
// about ANY page or feature of the website.
const APP_CONTEXT = [
  'PRODUCT: "HealthYoda" — an AI voice assistant for hospital PRE-CONSULTATION (medical intake). Before a patient sees the doctor, an empathetic AI voice agent talks with them in their own language, asks about their symptoms and history, and prepares a structured summary for the doctor so the consultation is faster and better prepared.',
  '',
  'HOW THE VOICE INTAKE WORKS: The patient (or staff) starts a session and gives consent. The assistant greets them and asks ONE question at a time by voice (or text) — first whether it is a first or returning visit, their name and age, then their main complaint, and follow-ups about onset, location, severity, what makes it better/worse, associated symptoms, past history, medicines, allergies, and family/habits. The patient answers naturally; at the end it thanks them and the doctor reviews the summary. It is NOT a doctor — it gives no diagnosis, treatment, or medicine advice.',
  '',
  'LANGUAGES: The whole experience works in English, Hindi, and Telugu — chosen on screen at the start of a session, and also switchable in this help assistant.',
  '',
  'SAFETY / EMERGENCIES: If a patient mentions a serious symptom (chest pain, breathing trouble, heavy bleeding, fainting, stroke signs, etc.), the system instantly flags a "red flag", alerts the medical team, reassures the patient that a doctor is coming, and stops the intake.',
  '',
  'RETURNING PATIENTS: Patients are recognised across visits by their phone number / patient ID, so their details and a rolling medical history are kept and built up over time.',
  '',
  'PRIVACY: Patient data is stored encrypted, used only for the patient\'s care, shared only with their doctor, and consent is taken before each session.',
  '',
  'THE WEBSITE PAGES (left sidebar) for hospital staff/clinicians:',
  '- Dashboard: overview and key stats (recent sessions, red-flag alerts, activity).',
  '- New Session: start a live voice intake — pick the language, enter the patient phone/ID, take consent, and begin the voice conversation.',
  '- Sessions: list of all intake sessions; open any one to read its transcript, view/generate the doctor report, or (admins) delete a session.',
  '- Patients: the patient directory — each patient\'s demographics, rolling medical history across visits, and their list of visits; admins can delete a patient (which also removes their sessions).',
  '- Analytics: usage and cost insights (token usage, estimated cost, per-model/session breakdowns).',
  '- Intake Links (admins only): generate a shareable link so a patient can do their intake remotely from their own phone, with no login.',
  '- Users (admins only): manage staff accounts and roles.',
  '- Settings: system configuration — the AI provider/model, the assistant voice, temperature/response length, and the clinic\'s medical instructions.',
  '',
  'REPORTS: After a session, a clinical summary report can be generated from the conversation; doctors/admins can review, edit, and approve it, and it can be exported in the FHIR healthcare-data format.',
  'ROLES: There are admin, doctor, and nurse roles; some pages and actions (Intake Links, Users, deleting data) are admin-only.',
  'THIS HELP ASSISTANT: a floating multilingual (English/Hindi/Telugu) helper, by text or voice, that answers questions about how the app works and general questions — but never gives medical advice.'
].join('\n');

// Small fixed phrases the service needs directly, per language.
const EMPTY_PROMPT: Record<Lang, string> = {
  'te-IN': 'దయచేసి మీ ప్రశ్న చెప్పండి.',
  'hi-IN': 'कृपया अपना सवाल बताएँ।',
  'en-IN': 'Please type your question.'
};

// The knowledge base: every topic the help bot can answer. `desc` is an English hint for
// the classifier; `answers` holds the verified reply in each language (returned as-is).
const FAQ: Record<string, { desc: string; answers: Record<Lang, string> }> = {
  what_it_does: {
    desc: 'what the app/assistant is, what it does, its purpose',
    answers: {
      'te-IN': 'ఇది మీరు డాక్టర్‌ను కలవడానికి ముందు మీ ఆరోగ్య సమస్య గురించి మాట్లాడి వివరాలు అడిగే ఒక సహాయకి. మీ సమాధానాలతో డాక్టర్ కోసం ఒక సారాంశం తయారు చేస్తుంది, తద్వారా సంప్రదింపు సమయం ఆదా అవుతుంది.',
      'hi-IN': 'यह एक सहायक है जो डॉक्टर से मिलने से पहले आपकी स्वास्थ्य समस्या के बारे में आपसे बात करता है। आपके उत्तरों से यह डॉक्टर के लिए एक सारांश तैयार करता है, जिससे परामर्श का समय बचता है।',
      'en-IN': 'This is an assistant that talks with you before you see the doctor, to understand your health problem. From your answers it prepares a summary for the doctor, so your consultation time is used well.'
    }
  },
  how_to_use: {
    desc: 'how to use the app, how to answer, how to talk to it',
    answers: {
      'te-IN': 'సహాయకి ఒక్కో ప్రశ్న అడుగుతుంది. మీరు మీ మాటల్లో సమాధానం చెప్పి, తదుపరి ప్రశ్న కోసం వేచి ఉండండి. ఒకేసారి ఒక ప్రశ్నకు సమాధానం ఇవ్వండి, నిశ్శబ్ద ప్రదేశంలో స్పష్టంగా మాట్లాడండి.',
      'hi-IN': 'सहायक एक-एक करके सवाल पूछता है। आप अपने शब्दों में जवाब दें और अगले सवाल का इंतज़ार करें। एक समय में एक ही सवाल का जवाब दें, और शांत जगह पर साफ़ बोलें।',
      'en-IN': 'The assistant asks one question at a time. Answer in your own words and wait for the next question. Answer one question at a time, and speak clearly in a quiet place.'
    }
  },
  getting_started: {
    desc: 'how to start or begin a session, what happens first, registration',
    answers: {
      'te-IN': 'ఆసుపత్రి సిబ్బంది ఒక సెషన్ ప్రారంభించి మీ అనుమతి తీసుకుంటారు. ఆ తర్వాత సహాయకి ప్రశ్నలు అడగడం మొదలుపెడుతుంది, మీరు మాట్లాడి లేదా టైప్ చేసి సమాధానం చెప్పవచ్చు.',
      'hi-IN': 'अस्पताल के कर्मचारी एक सेशन शुरू करते हैं और आपकी सहमति लेते हैं। उसके बाद सहायक सवाल पूछना शुरू करता है, और आप बोलकर या टाइप करके जवाब दे सकते हैं।',
      'en-IN': 'The hospital staff start a session and take your consent. Then the assistant begins asking questions, and you can answer by speaking or typing.'
    }
  },
  is_doctor: {
    desc: 'is it a doctor, does it diagnose, will it give medicine or treatment or advice',
    answers: {
      'te-IN': 'ఇది డాక్టర్ కాదు. ఇది వ్యాధి నిర్ధారణ చేయదు, మందులు లేదా చికిత్స సూచించదు. ఇది కేవలం మీ సమాచారాన్ని డాక్టర్ కోసం సేకరిస్తుంది.',
      'hi-IN': 'यह डॉक्टर नहीं है। यह बीमारी की पहचान नहीं करता, न दवा या इलाज बताता है। यह केवल डॉक्टर के लिए आपकी जानकारी इकट्ठा करता है।',
      'en-IN': 'This is not a doctor. It does not diagnose illness or prescribe medicine or treatment. It only collects your information for the doctor.'
    }
  },
  privacy: {
    desc: 'data privacy, security, is my information safe, who sees it, consent, encryption',
    answers: {
      'te-IN': 'మీ సమాచారం సురక్షితంగా ఉంటుంది. సెషన్ ప్రారంభించే ముందు మీ అనుమతి తీసుకుంటాం. మీ వివరాలు మీ వైద్య సంరక్షణ కోసం మాత్రమే వాడతాం, encrypted పద్ధతిలో నిల్వ చేస్తాం, మీ డాక్టర్‌తో మాత్రమే పంచుకుంటాం.',
      'hi-IN': 'आपकी जानकारी सुरक्षित रहती है। सेशन से पहले हम आपकी सहमति लेते हैं। आपकी जानकारी केवल आपके इलाज के लिए उपयोग की जाती है, सुरक्षित (encrypted) रूप में रखी जाती है, और केवल आपके डॉक्टर के साथ साझा की जाती है।',
      'en-IN': 'Your information is kept safe. We take your consent before the session. Your details are used only for your medical care, stored securely (encrypted), and shared only with your doctor.'
    }
  },
  language: {
    desc: 'what language can I speak, is Telugu/Hindi/English supported, how to change language',
    answers: {
      'te-IN': 'మీరు ఈ యాప్‌ను ఇంగ్లీష్, హిందీ లేదా తెలుగులో వాడవచ్చు. పైన ఉన్న భాషా బటన్‌లతో మీకు నచ్చిన భాషను ఎంచుకోండి.',
      'hi-IN': 'आप इस ऐप का उपयोग अंग्रेज़ी, हिंदी या तेलुगु में कर सकते हैं। ऊपर दिए गए भाषा बटनों से अपनी पसंद की भाषा चुनें।',
      'en-IN': 'You can use this app in English, Hindi, or Telugu. Pick the language you are comfortable with using the language buttons at the top.'
    }
  },
  mic_help: {
    desc: 'microphone problems, cannot hear, audio not working, how to pause, repeat, interrupt',
    answers: {
      'te-IN': 'మైక్రోఫోన్ అనుమతి ఇవ్వండి, హెడ్‌ఫోన్‌లు వాడితే మంచిది. సహాయకి మాట్లాడటం పూర్తయ్యాక మీరు సమాధానం చెప్పండి. మాట్లాడటం మొదలుపెట్టడానికి లేదా ఆపడానికి మైక్ బటన్ నొక్కండి.',
      'hi-IN': 'कृपया माइक्रोफ़ोन की अनुमति दें; हेडफ़ोन का उपयोग बेहतर रहता है। सहायक की बात पूरी होने के बाद जवाब दें। बोलना शुरू या बंद करने के लिए माइक बटन दबाएँ।',
      'en-IN': 'Please allow microphone access; headphones help. Speak after the assistant finishes talking. Tap the mic button to start or stop speaking.'
    }
  },
  red_flags: {
    desc: 'emergency, serious symptom, chest pain, what if it is urgent',
    answers: {
      'te-IN': 'మీరు గుండె నొప్పి, ఊపిరి ఆడకపోవడం, ఎక్కువ రక్తస్రావం, స్పృహ తప్పడం లాంటి తీవ్రమైన లక్షణాలు చెబితే, సిస్టమ్ వెంటనే వైద్య బృందాన్ని అప్రమత్తం చేస్తుంది. అత్యవసరమైతే వెంటనే సిబ్బందికి తెలియజేయండి.',
      'hi-IN': 'अगर आप सीने में दर्द, साँस लेने में तकलीफ़, ज़्यादा खून बहना, या बेहोशी जैसी गंभीर समस्या बताते हैं, तो सिस्टम तुरंत चिकित्सा टीम को सूचित करता है। आपात स्थिति में तुरंत कर्मचारियों को बताएँ।',
      'en-IN': 'If you mention a serious symptom such as chest pain, breathing difficulty, heavy bleeding, or fainting, the system immediately alerts the medical team. In an emergency, tell the staff right away.'
    }
  },
  duration: {
    desc: 'how long does it take, how many questions, time',
    answers: {
      'te-IN': 'సాధారణంగా ఇది కొన్ని నిమిషాలే పడుతుంది. సుమారు పది చిన్న ప్రశ్నలు ఉంటాయి, మీరు మీ వేగంతో సమాధానం చెప్పవచ్చు.',
      'hi-IN': 'आमतौर पर इसमें कुछ ही मिनट लगते हैं। लगभग दस छोटे सवाल होते हैं, और आप अपनी गति से जवाब दे सकते हैं।',
      'en-IN': 'It usually takes only a few minutes. There are about ten short questions, and you can answer at your own pace.'
    }
  },
  after_session: {
    desc: 'what happens after the session, what next, do I get a report',
    answers: {
      'te-IN': 'సెషన్ పూర్తయ్యాక సహాయకి మీకు ధన్యవాదాలు చెబుతుంది. ఆ తర్వాత మీ వివరాల సారాంశాన్ని డాక్టర్ చూసి, మిమ్మల్ని పరిశీలిస్తారు.',
      'hi-IN': 'सेशन पूरा होने पर सहायक आपको धन्यवाद कहता है। उसके बाद डॉक्टर आपकी जानकारी का सारांश देखकर आपको देखते हैं।',
      'en-IN': 'When the session ends, the assistant thanks you. The doctor then reviews the summary of your details and sees you.'
    }
  },
  greeting: {
    desc: 'a greeting like hello/hi, or asking who are you (the help bot)',
    answers: {
      'te-IN': 'నమస్కారం! నేను ఈ యాప్ గురించి మీకు సహాయం చేసే సహాయకుడిని. యాప్‌ను ఎలా వాడాలి, ఇది ఏం చేస్తుంది లాంటి విషయాలు అడగవచ్చు.',
      'hi-IN': 'नमस्ते! मैं इस ऐप में आपकी मदद करने वाला सहायक हूँ। आप पूछ सकते हैं कि ऐप कैसे इस्तेमाल करें, यह क्या करता है, वगैरह।',
      'en-IN': "Hello! I'm the assistant that helps you with this app. You can ask how to use the app, what it does, and similar things."
    }
  },
  medical: {
    desc: 'a request for HEALTH/MEDICAL ADVICE about a person\'s body — their own symptoms, what medicine to take, a diagnosis, or treatment. NOT questions about how the app works.',
    answers: {
      'te-IN': 'క్షమించండి, నేను వైద్య సలహా ఇవ్వలేను. మీ ఆరోగ్య సమస్య గురించి సంప్రదింపు సమయంలో డాక్టర్ మీకు సహాయం చేస్తారు. నేను ఈ యాప్‌ను వాడటంలో మాత్రమే మీకు సహాయం చేయగలను.',
      'hi-IN': 'क्षमा करें, मैं चिकित्सा सलाह नहीं दे सकता। आपकी स्वास्थ्य समस्या में परामर्श के दौरान डॉक्टर आपकी मदद करेंगे। मैं केवल इस ऐप के उपयोग में आपकी मदद कर सकता हूँ।',
      'en-IN': "Sorry, I can't give medical advice. The doctor will help you with your health problem during the consultation. I can only help you with using this app."
    }
  },
  out_of_scope: {
    desc: 'a question about the website/app or its pages/features NOT covered by the topics above (e.g. the Patients, Sessions, Analytics, Settings pages), OR a general/other question (weather, news, chit-chat, general knowledge), OR unclear',
    answers: {
      'te-IN': 'క్షమించండి, నేను ఈ యాప్ గురించి మాత్రమే సహాయం చేయగలను. ఇతర విషయాల కోసం దయచేసి ఆసుపత్రి సిబ్బందిని అడగండి.',
      'hi-IN': 'क्षमा करें, मैं केवल इस ऐप के बारे में मदद कर सकता हूँ। अन्य चीज़ों के लिए कृपया अस्पताल के कर्मचारियों से पूछें।',
      'en-IN': 'Sorry, I can only help with this app. For other things, please ask the hospital staff.'
    }
  }
};

const TOPIC_KEYS = Object.keys(FAQ);

const CLASSIFIER_PROMPT = [
  'You are a router for a hospital app\'s help assistant. Read the patient\'s message (it may be in English, Hindi, or Telugu) and decide which ONE topic key best matches it.',
  'Output ONLY the single key (lowercase, exactly as written) and nothing else — no punctuation, no explanation.',
  '',
  'Keys and when to use them:',
  ...TOPIC_KEYS.map(k => `- ${k}: ${FAQ[k].desc}`),
  '',
  '',
  'IMPORTANT: "medical" is ONLY for a request for health/medical ADVICE about a person\'s body — their own symptoms, a diagnosis, or what medicine/treatment to take. Do NOT use "medical" for questions about how this app/website works, even if they mention words like patient, doctor, report, session, or symptom. For example, "what does the Patients page do" is NOT medical — it is out_of_scope.',
  'For any question about a website page or feature that is not one of the specific topics above, and for general or other questions, use "out_of_scope" (these are answered helpfully elsewhere). When unsure, use "out_of_scope" — never default to "medical".'
].join('\n');

let client: SarvamAIClient | null = null;
function getClient(): SarvamAIClient {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not configured');
  if (!client) client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
  return client;
}

function sanitize(text: string): string {
  return String(text || '').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
}

/** Map the model's raw output to a known topic key (robust to extra words/casing). */
function resolveKey(raw: string): string {
  const out = String(raw || '').toLowerCase();
  // Prefer an exact token match, then a substring match; default to out_of_scope.
  const tokens = out.split(/[^a-z_]+/).filter(Boolean);
  for (const k of TOPIC_KEYS) if (tokens.includes(k)) return k;
  for (const k of TOPIC_KEYS) if (out.includes(k)) return k;
  return 'out_of_scope';
}

/** System prompt for the free-form answer path (website + general/outside questions). */
function generalSystemPrompt(lang: Lang): string {
  const label = LANG_LABEL[lang];
  return [
    'You are a friendly, helpful assistant embedded in a hospital pre-consultation web app.',
    `Reply ONLY in ${label}, in 1 to 3 short, clear, natural sentences. Be warm and concise.`,
    'You can answer general/everyday questions, casual conversation, and questions about this website/app.',
    'Use the App context below to answer questions about the website/app accurately and helpfully.',
    'SAFETY (must follow): never give a medical diagnosis, treatment, or medicine/dosage advice. If asked a health/medical question, gently say the doctor will help during the consultation.',
    'Do not invent specific facts you are unsure about; if you do not know, say so briefly. Output plain spoken sentences only — no markdown, no bullet lists.',
    '',
    `App context: ${APP_CONTEXT}`
  ].join('\n');
}

/**
 * Free-form answer for questions NOT covered by the verified FAQ — i.e. broader questions
 * about the website/app and general/outside questions. The LLM answers naturally in the
 * chosen language (with app context + a medical-advice guardrail). Falls back to the safe
 * defer line if the model returns nothing.
 */
async function generalAnswer(message: string, history: ChatTurn[], lang: Lang): Promise<string> {
  const msgs = [
    { role: 'system', content: generalSystemPrompt(lang) },
    ...history.slice(-6).map(h => ({ role: h.role, content: String(h.content || '').slice(0, 500) })),
    { role: 'user', content: message.slice(0, 500) }
  ];
  const resp: any = await getClient().chat.completions({
    model: GENERAL_MODEL,
    messages: msgs as any,
    temperature: 0.4,
    max_tokens: 220,
    reasoning_effort: null
  } as any);
  const text = sanitize(resp?.choices?.[0]?.message?.content || '');
  return text || FAQ.out_of_scope.answers[lang];
}

/**
 * Answer a patient/staff question in the requested language. A small LLM first CLASSIFIES
 * the question into a topic. For the known app topics the reply is the PRE-WRITTEN, verified
 * answer (always accurate, never invents) and medical questions are safely deferred to the
 * doctor. For anything else (broader website questions, general/outside questions) the LLM
 * answers FREE-FORM via generalAnswer() — so the bot is genuinely helpful, not just a wall
 * of "ask the staff", while the medical guardrail still holds.
 */
export async function answerQuestion(
  message: string, history: ChatTurn[] = [], language: any = DEFAULT_LANG
): Promise<string> {
  const lang = toLang(language);
  const trimmed = String(message || '').trim();
  if (!trimmed) return EMPTY_PROMPT[lang];

  let key = 'out_of_scope';
  try {
    const resp: any = await getClient().chat.completions({
      model: CLASSIFY_MODEL,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: trimmed.slice(0, 500) }
      ] as any,
      temperature: 0,
      max_tokens: 12,
      reasoning_effort: null
    } as any);
    key = resolveKey(resp?.choices?.[0]?.message?.content || '');
    console.log(`🤖 assistant topic -> ${key} (lang=${lang})`); // topic key only (no PHI/user text)
  } catch (e: any) {
    console.error('assistant classify failed:', e?.message || e);
    // Fall through: treat as out_of_scope (free-form answer below).
  }

  // Known app topic → verified pre-written answer. Medical → safe deferral (guardrail).
  if (key !== 'out_of_scope' && FAQ[key]) return FAQ[key].answers[lang];

  // Everything else → free-form helpful answer (website + general/outside questions).
  try {
    return await generalAnswer(trimmed, Array.isArray(history) ? history : [], lang);
  } catch (e: any) {
    console.error('assistant general answer failed:', e?.message || e);
    return FAQ.out_of_scope.answers[lang];
  }
}

/** Synthesize speech for an answer in the given language. Returns base64-encoded WAV. */
export async function speak(text: string, language: any = DEFAULT_LANG): Promise<string> {
  const lang = toLang(language);
  const clean = sanitize(text).slice(0, 800);
  if (!clean) throw new Error('No text to speak');
  const resp: any = await getClient().textToSpeech.convert({
    text: clean,
    target_language_code: lang,
    speaker: TTS_SPEAKER,
    model: TTS_MODEL
  } as any);
  const audio = resp?.audios?.[0];
  if (!audio) throw new Error('TTS returned no audio');
  return audio; // base64 WAV
}

/** Transcribe a recorded patient question (in `language`) to text via Sarvam batch STT. */
export async function transcribe(
  audioBuffer: Buffer, mime = 'audio/webm', language: any = DEFAULT_LANG
): Promise<string> {
  const lang = toLang(language);
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const tmp = path.join(os.tmpdir(), `assistant-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.promises.writeFile(tmp, audioBuffer);
  try {
    const resp: any = await getClient().speechToText.transcribe({
      file: fs.createReadStream(tmp) as any,
      model: STT_MODEL,
      language_code: lang
    } as any);
    return sanitize(resp?.transcript || '');
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}
