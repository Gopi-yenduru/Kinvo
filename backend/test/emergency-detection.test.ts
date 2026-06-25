import { describe, it, expect } from 'vitest';
import { detectEmergency, EMERGENCY_MESSAGE, emergencyMessage } from '../src/emergency.js';

// Patient-safety regression guard: the multilingual voice agent must escalate emergencies
// deterministically (sarvam-30b frequently skips the red_flag tool call), so the detector
// must fire on red-flag utterances in Telugu / Hindi / English and stay quiet on benign ones.

describe('detectEmergency: fires on red-flag utterances', () => {
  const emergencies: Array<[string, string]> = [
    // Telugu
    ['te: chest pain + breathless', 'నాకు ఛాతీలో గట్టిగా నొప్పిగా ఉంది, ఊపిరి కూడా సరిగా ఆడట్లేదు'],
    ['te: heart pain',              'గుండెల్లో నొప్పి వస్తోంది'],
    ['te: cannot breathe',          'ఊపిరి ఆడట్లేదు'],
    ['te: severe bleeding',         'చాలా రక్తం ఎక్కువగా కారుతోంది, ఆగట్లేదు'],
    ['te: loss of consciousness',   'మధ్యలో స్పృహ తప్పింది'],
    ['te: seizure',                 'ఫిట్స్ వచ్చాయి'],
    ['te: suicidal',                'నాకు చనిపోవాలని అనిపిస్తోంది'],
    // Hindi
    ['hi: chest pain',              'मेरे सीने में बहुत दर्द हो रहा है'],
    ['hi: cannot breathe',          'मुझे साँस लेने में दिक्कत हो रही है, दम घुट रहा है'],
    ['hi: severe bleeding',         'बहुत ज्यादा खून बह रहा है, रुक नहीं रहा'],
    ['hi: unconscious',             'वह बेहोश हो गया'],
    ['hi: stroke/paralysis',        'अचानक लकवा मार गया'],
    ['hi: suicidal',                'मेरा मरना चाहता है मन'],
    // English (STT fallback)
    ['en: chest pain',              'I have chest pain and I feel breathless'],
    // Additional real-world phrasings
    ['te: heart heaviness',         'గుండెల్లో ఏదో బరువుగా, నొప్పిగా అనిపిస్తోంది'],
    ['te: breathing very hard',     'ఆయాసంగా ఉంది, ఊపిరి తీసుకోవడం చాలా కష్టంగా ఉంది'],
    ['te: stroke signs',            'హఠాత్తుగా పక్షవాతం వచ్చినట్టు అనిపిస్తోంది'],
    ['hi: heart attack feeling',    'लग रहा है दिल का दौरा पड़ रहा है, सीने में जलन है'],
    ['hi: fainting',                'चक्कर आकर बेहोश हो गई थी'],
    ['hi: blood not stopping',      'घाव से खून बंद ही नहीं हो रहा, बहुत बह रहा है'],
    ['en: severe bleeding',         'there is severe bleeding and I feel faint'],
    ['en: suicidal',                'I feel suicidal, I want to end my life'],
  ];
  it.each(emergencies)('detects %s', (_label, utterance) => {
    expect(detectEmergency(utterance)).toBe(true);
  });
});

describe('detectEmergency: no false positives on benign utterances', () => {
  const benign: Array<[string, string]> = [
    ['te: fever + cough',  'రెండు రోజుల నుంచి జ్వరం, దగ్గు ఉంది'],
    ['te: mild foot pain', 'కాలికి కొంచెం నొప్పిగా ఉంది'],
    ['hi: fever + cough',  'दो दिन से बुखार और खांसी है'],
    ['hi: mild leg pain',  'पैर में थोड़ा दर्द है'],
    ['en: headache',       'I have a mild headache'],
    ['empty',              ''],
  ];
  it.each(benign)('ignores %s', (_label, utterance) => {
    expect(detectEmergency(utterance)).toBe(false);
  });
});

describe('emergency reassurance message per language', () => {
  it('te/hi/en each promise a doctor immediately', () => {
    expect(EMERGENCY_MESSAGE['te-IN']).toContain('డాక్టర్');     // doctor
    expect(EMERGENCY_MESSAGE['te-IN']).toContain('వెంటనే');       // immediately
    expect(EMERGENCY_MESSAGE['hi-IN']).toContain('डॉक्टर');       // doctor
    expect(EMERGENCY_MESSAGE['hi-IN']).toContain('तुरंत');        // immediately
    expect(EMERGENCY_MESSAGE['en-IN'].toLowerCase()).toContain('doctor');
    expect(EMERGENCY_MESSAGE['en-IN'].toLowerCase()).toContain('immediately');
  });
  it('falls back to Telugu for an unknown language', () => {
    expect(emergencyMessage('xx-YY')).toBe(EMERGENCY_MESSAGE['te-IN']);
  });
});
