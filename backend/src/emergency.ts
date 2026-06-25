/**
 * Emergency (red-flag) safety net for the multilingual voice intake agent.
 * =====================================================================================
 * sarvam-30b frequently SKIPS the red_flag_detected tool call, so escalation must NOT
 * depend on the LLM. SarvamProvider scans every patient utterance with detectEmergency();
 * on a hit it fires the alert itself and forces EMERGENCY_MESSAGE[lang] to the front of
 * the agent's spoken reply, so the patient always hears that a doctor is being sent
 * immediately. Kept in its own module so the detector is unit-testable without the
 * provider's db/cache/auth import chain.
 */

export type Lang = 'te-IN' | 'hi-IN' | 'en-IN';

// Spoken to the patient on any emergency, in the session's language: "Don't worry. I'm
// informing the doctor right now — they'll come to you immediately. Please stay where
// you are and remain calm."
export const EMERGENCY_MESSAGE: Record<Lang, string> = {
  'te-IN': 'ఆందోళన పడకండి. నేను ఇప్పుడే డాక్టర్‌కు తెలియజేస్తున్నాను, వారు వెంటనే మీ దగ్గరకు వస్తారు. దయచేసి అక్కడే ప్రశాంతంగా ఉండండి.',
  'hi-IN': 'घबराइए मत। मैं अभी डॉक्टर को सूचित कर रही हूँ, वे तुरंत आपके पास आएँगे। कृपया वहीं शांति से रहें।',
  'en-IN': 'Please don’t worry. I’m informing the doctor right now, and they will come to you immediately. Please stay where you are and stay calm.',
};

/** Emergency reassurance for a language, falling back to Telugu. */
export const emergencyMessage = (lang: string): string =>
  EMERGENCY_MESSAGE[(lang as Lang)] || EMERGENCY_MESSAGE['te-IN'];

// Each pattern pairs a body part / sign with a qualifier so benign mentions (a mild
// foot ache, a headache) do not trip the alert. Telugu, Hindi, and an English fallback
// (Sarvam STT sometimes returns English medical words) are all matched, since one
// detector serves every session language.
export const EMERGENCY_PATTERNS: RegExp[] = [
  // ── Telugu ──
  /(ఛాతి|ఛాతీ|గుండె|హార్ట).{0,15}(నొప్పి|నెప్పి|పోటు|బరువు|మంట)/,   // chest / heart pain or pressure
  /(నొప్పి|పోటు).{0,15}(ఛాతి|ఛాతీ|గుండె)/,
  /ఊపిరి.{0,20}(ఆడ|రాట|ఇబ్బంది|కష్ట|పీల్చ)/,                          // breathlessness
  /శ్వాస.{0,20}(ఆడ|ఇబ్బంది|కష్ట|తీసుకో|ఆగ)/,
  /ఆయాస/,                                                              // dyspnea / panting
  /(రక్తం|రక్తస్రావం).{0,15}(ఎక్కువ|ఆగ|ఆపలే|కారు|నిలవ)/,              // severe bleeding
  /స్పృహ.{0,10}(తప్|కోల్పో|లేదు)/,                                     // loss of consciousness
  /మూర్ఛ|ఫిట్స్|పక్షవాతం|పక్షవాత/,                                      // seizure / stroke
  /ఆత్మహత్య|చనిపోవ|చావాల/,                                             // suicidal

  // ── Hindi ──
  /(छाती|सीने|सीना|दिल|हृदय).{0,15}(दर्द|दबाव|भारी|जलन)/,             // chest / heart pain or pressure
  /(दर्द|दबाव).{0,15}(छाती|सीने|दिल)/,
  /(साँस|सांस|दम).{0,15}(नहीं|घुट|तकलीफ|फूल|रुक|दिक्कत)/,            // breathlessness
  /(खून|रक्तस्राव|ब्लीडिंग).{0,25}(ज़्यादा|ज्यादा|बहुत|रुक|बंद नहीं|बह)/, // severe bleeding
  /बेहोश|होश.{0,8}(नहीं|खो|उड़)/,                                       // loss of consciousness
  /दौरा|मिर्गी|लकवा|पक्षाघात/,                                          // seizure / stroke
  /आत्महत्या|खुदकुशी|जान देना|मरना चाहत|मर जाऊँ|मर जाउ/,               // suicidal

  // ── English fallback ──
  /chest pain|heart attack|can'?t breathe|cannot breathe|breathless|short of breath|severe bleeding|unconscious|fainting|stroke|seizure|suicid/i,
];

/** True when the patient's (Telugu / Hindi / English) utterance signals a medical emergency. */
export const detectEmergency = (text: string): boolean =>
  !!text && EMERGENCY_PATTERNS.some(re => re.test(text));
