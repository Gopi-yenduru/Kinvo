import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { VoiceClient } from '../lib/voiceClient';

/**
 * PatientIntake — the PUBLIC, login-free page a patient opens from a shared link
 * (/intake/:token). It runs the exact same Sarvam voice intake as the in-clinic
 * Session page (via VoiceClient), but is self-contained: validate link → consent +
 * language → one record control → End → "submitted to your doctor".
 */

type Phase = 'loading' | 'blocked' | 'consent' | 'connecting' | 'active' | 'done';

interface Msg { speaker: 'Agent' | 'You' | 'System' | 'Alert'; message: string; ts: string; }

type Lang = 'te-IN' | 'hi-IN' | 'en-IN';

const LANG_OPTIONS = [
  { code: 'te-IN', label: 'తెలుగు', sub: 'Telugu' },
  { code: 'hi-IN', label: 'हिंदी', sub: 'Hindi' },
  { code: 'en-IN', label: 'English', sub: 'English' },
] as const;

// Compact translations for the patient-facing UI. Consent copy mirrors the in-clinic form.
const T: Record<Lang, Record<string, string>> = {
  'te-IN': {
    startTitle: 'వాయిస్ ఇంటేక్',
    startSub: 'మీ వైద్యుని కోసం కొన్ని ఆరోగ్య ప్రశ్నలకు సమాధానం ఇవ్వండి.',
    langLabel: 'భాష',
    consent: 'ఇది మీ వైద్యుని కోసం సమాచారం సేకరించే AI వాయిస్ సహాయకి. మీ సమాధానాలు, ఆడియో రికార్డ్ చేసి ప్రాసెస్ చేయబడతాయి. ఇది రోగ నిర్ధారణ లేదా చికిత్స ఇవ్వదు. మీరు ఎప్పుడైనా ఆపవచ్చు.',
    consentCheck: 'నేను అంగీకరిస్తున్నాను',
    start: 'ప్రారంభించండి',
    micOn: 'మాట్లాడండి', micOff: 'పాజ్',
    end: 'సెషన్ ముగించండి', ending: 'ముగిస్తోంది…',
    connecting: 'కనెక్ట్ అవుతోంది…',
    listening: 'వింటోంది', speaking: 'మాట్లాడుతోంది', thinking: 'ఆలోచిస్తోంది', ready: 'సిద్ధం',
    doneTitle: 'ధన్యవాదాలు!', doneMsg: 'మీ సమాధానాలు మీ వైద్యునికి పంపబడ్డాయి. మీరు ఈ పేజీని మూసివేయవచ్చు.',
    micErr: 'మైక్రోఫోన్ యాక్సెస్ అవసరం. దయచేసి అనుమతించి మళ్లీ ప్రయత్నించండి.',
    retry: 'మళ్లీ ప్రయత్నించండి',
  },
  'hi-IN': {
    startTitle: 'वॉइस इनटेक',
    startSub: 'अपने डॉक्टर के लिए कुछ स्वास्थ्य प्रश्नों के उत्तर दें।',
    langLabel: 'भाषा',
    consent: 'यह आपके डॉक्टर के लिए जानकारी इकट्ठा करने वाली एक AI वॉइस सहायक है। आपके उत्तर और ऑडियो रिकॉर्ड और प्रोसेस किए जाते हैं। यह निदान या इलाज नहीं देती। आप कभी भी रोक सकते हैं।',
    consentCheck: 'मैं सहमत हूँ',
    start: 'शुरू करें',
    micOn: 'बोलें', micOff: 'रोकें',
    end: 'सेशन समाप्त करें', ending: 'समाप्त हो रहा है…',
    connecting: 'कनेक्ट हो रहा है…',
    listening: 'सुन रहा है', speaking: 'बोल रहा है', thinking: 'सोच रहा है', ready: 'तैयार',
    doneTitle: 'धन्यवाद!', doneMsg: 'आपके उत्तर आपके डॉक्टर को भेज दिए गए हैं। आप यह पेज बंद कर सकते हैं।',
    micErr: 'माइक्रोफ़ोन की अनुमति आवश्यक है। कृपया अनुमति दें और पुनः प्रयास करें।',
    retry: 'पुनः प्रयास करें',
  },
  'en-IN': {
    startTitle: 'Voice Intake',
    startSub: 'Answer a few health questions to prepare information for your doctor.',
    langLabel: 'Language',
    consent: 'This is an AI voice assistant that will ask health questions to prepare information for your doctor. Your responses and audio are recorded and processed to create a summary for the clinician. It does not provide diagnosis or treatment. You may stop at any time.',
    consentCheck: 'I consent to this AI intake and data processing',
    start: 'Start',
    micOn: 'Speak', micOff: 'Pause',
    end: 'End Session', ending: 'Ending…',
    connecting: 'Connecting…',
    listening: 'Listening', speaking: 'Speaking', thinking: 'Thinking', ready: 'Ready',
    doneTitle: 'Thank you!', doneMsg: 'Your answers have been submitted to your doctor. You can close this page.',
    micErr: 'Microphone access is required. Please allow it and try again.',
    retry: 'Try again',
  },
};

const PatientIntake: React.FC = () => {
  const { token } = useParams<{ token: string }>();

  const [phase, setPhase] = useState<Phase>('loading');
  const [blocked, setBlocked] = useState<{ title: string; message: string }>({ title: '', message: '' });
  const [language, setLanguage] = useState<Lang>('te-IN');
  const [provider, setProvider] = useState<string>(''); // configured AI provider (from link info)
  // Telugu/Hindi are only supported by the Sarvam pipeline; OpenAI/Retell are English-only.
  const multilingual = provider === 'sarvam';
  const [consent, setConsent] = useState(false);
  const [log, setLog] = useState<Msg[]>([]);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeakingAgent, setIsSpeakingAgent] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [ending, setEnding] = useState(false);

  const clientRef = useRef<VoiceClient | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const t = T[language];

  // Validate the link on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/intake/${token}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.valid) {
          if (data.provider) setProvider(data.provider);
          // Force a valid language for the provider: English-only providers → English; Sarvam →
          // te/hi only (fall back to Telugu if a stale link stored English).
          let forced = data.language;
          if (data.provider && data.provider !== 'sarvam') forced = 'en-IN';
          else if (data.provider === 'sarvam' && data.language === 'en-IN') forced = 'te-IN';
          if (forced && ['te-IN', 'hi-IN', 'en-IN'].includes(forced)) setLanguage(forced);
          setPhase('consent');
        } else {
          setBlocked({ title: titleForError(data.error), message: data.message || 'This link cannot be used.' });
          setPhase('blocked');
        }
      } catch {
        if (!cancelled) { setBlocked({ title: 'Connection problem', message: 'Could not reach the server. Please check your connection and try again.' }); setPhase('blocked'); }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Tear down the voice client if the patient leaves the page.
  useEffect(() => () => { clientRef.current?.stop().catch(() => {}); clientRef.current = null; }, []);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [log]);

  const addMsg = useCallback((speaker: Msg['speaker'], message: string) => {
    if (!message || !message.trim()) return;
    setLog(prev => [...prev, { speaker, message: message.trim(), ts: new Date().toLocaleTimeString() }]);
  }, []);

  const markComplete = useCallback(async () => {
    try { await fetch(`/api/public/intake/${token}/complete`, { method: 'POST' }); } catch { /* best-effort */ }
  }, [token]);

  const startIntake = async () => {
    if (!consent) return;
    setErrorMsg('');
    setPhase('connecting');
    try {
      const res = await fetch(`/api/public/intake/${token}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentGiven: true, language }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sessionId || !data.wsToken) {
        // Link became unusable (expired/revoked/completed) or session failed to start.
        setBlocked({ title: titleForError(data.error), message: data.message || 'Could not start the session. Please contact the clinic.' });
        setPhase('blocked');
        return;
      }

      const client = new VoiceClient({
        onReady: () => { setStatus('idle'); addMsg('System', t.ready); },
        onStatus: (s) => {
          setStatus(s);
          if (s === 'speaking') { setIsSpeakingAgent(true); }
          else if (s === 'thinking') { setIsSpeakingAgent(false); }
          else if (s === 'listening') { setIsSpeakingAgent(false); setIsRecording(true); }
          else { setIsSpeakingAgent(false); }
        },
        onPatientTranscript: (text) => addMsg('You', text),
        onAgentTranscript: (text) => addMsg('Agent', text),
        onRedFlag: (symptoms, severity) => addMsg('Alert', `⚠️ ${severity.toUpperCase()}: ${symptoms}`),
        onError: (m) => setErrorMsg(m),
        onSessionEnded: () => { finishUp(); },
        onClose: () => { /* socket closed; finishUp handles normal end */ },
      });
      clientRef.current = client;

      await client.start(data.sessionId, data.wsToken);
      setIsRecording(true);
      setPhase('active');
    } catch (err) {
      console.error('Failed to start patient intake:', err);
      setErrorMsg(t.micErr);
      setPhase('consent'); // let them retry the mic permission
    }
  };

  const toggleMic = () => {
    const client = clientRef.current;
    if (!client) return;
    if (isSpeakingAgent) { client.interrupt(); return; } // barge-in while agent talks
    const next = !isRecording;
    setIsRecording(next);
    client.setMicEnabled(next);
  };

  // Shared end-of-session path: tear down audio, mark the link complete, show thank-you.
  const finishUp = useCallback(async () => {
    if (phase === 'done') return;
    setEnding(true);
    try { await clientRef.current?.stop(); } catch { /* ignore */ }
    clientRef.current = null;
    await markComplete();
    setIsRecording(false);
    setIsSpeakingAgent(false);
    setEnding(false);
    setPhase('done');
  }, [markComplete, phase]);

  const endSession = async () => {
    if (!window.confirm(language === 'te-IN' ? 'సెషన్‌ను ముగించాలా?' : language === 'hi-IN' ? 'क्या सेशन समाप्त करें?' : 'End the session and submit?')) return;
    await finishUp();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const shellStyle: React.CSSProperties = {
    minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'linear-gradient(160deg,#eff6ff 0%,#f8fafc 100%)', padding: '16px',
  };
  const cardStyle: React.CSSProperties = {
    width: '100%', maxWidth: 560, background: '#fff', borderRadius: 16,
    boxShadow: '0 10px 30px rgba(2,32,71,.12)', overflow: 'hidden',
  };

  const Brand = () => (
    <div style={{ background: 'linear-gradient(135deg,#1d4ed8,#0ea5e9)', color: '#fff', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,.2)', display: 'grid', placeItems: 'center' }}>
        <i className="fas fa-hospital"></i>
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '1.1rem', lineHeight: 1 }}>Kinvo</div>
        <small style={{ opacity: .85 }}>AI Voice Assistant</small>
      </div>
    </div>
  );

  if (phase === 'loading') {
    return (
      <div style={shellStyle}>
        <div style={{ ...cardStyle, padding: 40, textAlign: 'center', marginTop: '15vh' }}>
          <i className="fas fa-spinner fa-spin fa-2x text-primary mb-3"></i>
          <p className="text-muted mb-0">Loading…</p>
        </div>
      </div>
    );
  }

  if (phase === 'blocked') {
    return (
      <div style={shellStyle}>
        <div style={{ ...cardStyle, marginTop: '12vh' }}>
          <Brand />
          <div style={{ padding: 32, textAlign: 'center' }}>
            <i className="fas fa-circle-exclamation fa-3x text-warning mb-3"></i>
            <h4 className="fw-bold mb-2">{blocked.title}</h4>
            <p className="text-muted mb-0">{blocked.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div style={shellStyle}>
        <div style={{ ...cardStyle, marginTop: '12vh' }}>
          <Brand />
          <div style={{ padding: 36, textAlign: 'center' }}>
            <i className="fas fa-circle-check fa-3x text-success mb-3"></i>
            <h3 className="fw-bold mb-2">{t.doneTitle}</h3>
            <p className="text-muted mb-0">{t.doneMsg}</p>
          </div>
        </div>
      </div>
    );
  }

  // consent / connecting / active share the same shell with a body that changes.
  return (
    <div style={shellStyle}>
      <div style={cardStyle}>
        <Brand />

        {errorMsg && (
          <div className="alert alert-danger m-3 mb-0 py-2">{errorMsg}</div>
        )}

        {phase === 'consent' && (
          <div style={{ padding: 22 }}>
            <h4 className="fw-bold text-primary mb-1">{t.startTitle}</h4>
            <p className="text-muted">{t.startSub}</p>

            <label className="form-label fw-semibold">{t.langLabel}</label>
            <div className="btn-group w-100 mb-3" role="group">
              {LANG_OPTIONS.filter(opt => multilingual ? opt.code !== 'en-IN' : opt.code === 'en-IN').map(opt => (
                <button key={opt.code} type="button"
                  className={`btn ${language === opt.code ? 'btn-primary' : 'btn-outline-primary'} d-flex flex-column py-2`}
                  onClick={() => setLanguage(opt.code as Lang)}>
                  <span className="fw-semibold">{opt.label}</span>
                  <small className={language === opt.code ? 'text-white-50' : 'text-muted'}>{opt.sub}</small>
                </button>
              ))}
            </div>

            <div className="p-3 rounded-3 border bg-light mb-3">
              <p className="small text-muted mb-2">{t.consent}</p>
              <div className="form-check">
                <input className="form-check-input" type="checkbox" id="pConsent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <label className="form-check-label fw-semibold" htmlFor="pConsent">{t.consentCheck}</label>
              </div>
            </div>

            <button className="btn btn-primary btn-lg w-100 d-flex align-items-center justify-content-center gap-2" disabled={!consent} onClick={startIntake}>
              <i className="fas fa-microphone"></i>{t.start}
            </button>
            <p className="text-center text-muted small mt-2 mb-0"><i className="fas fa-lock me-1"></i>Secure • No app needed</p>
          </div>
        )}

        {phase === 'connecting' && (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <i className="fas fa-spinner fa-spin fa-2x text-primary mb-3"></i>
            <p className="text-muted mb-0">{t.connecting}</p>
          </div>
        )}

        {phase === 'active' && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
            {/* Status pill */}
            <div className="d-flex justify-content-center mb-2">
              <span className={`badge px-3 py-2 ${status === 'speaking' ? 'bg-primary' : status === 'listening' ? 'bg-success' : status === 'thinking' ? 'bg-warning text-dark' : 'bg-secondary'}`}>
                <i className={`fas me-2 ${status === 'speaking' ? 'fa-volume-high' : status === 'thinking' ? 'fa-ellipsis' : 'fa-microphone'}`}></i>
                {status === 'speaking' ? t.speaking : status === 'listening' ? t.listening : status === 'thinking' ? t.thinking : t.ready}
              </span>
            </div>

            {/* Conversation */}
            <div ref={messagesRef} style={{ height: '48vh', overflowY: 'auto', background: '#f8fafc', borderRadius: 12, padding: 12 }}>
              {log.length === 0 ? (
                <div className="text-center text-muted py-5"><i className="fas fa-comment-dots fa-2x mb-2 d-block opacity-50"></i>…</div>
              ) : log.map((m, i) => (
                <div key={i} className={`d-flex mb-2 ${m.speaker === 'You' ? 'justify-content-end' : 'justify-content-start'}`}>
                  <div className={`p-2 px-3 rounded-3 ${m.speaker === 'Agent' ? 'bg-primary-subtle' : m.speaker === 'You' ? 'bg-success-subtle' : m.speaker === 'Alert' ? 'bg-danger-subtle' : 'bg-secondary-subtle'}`} style={{ maxWidth: '85%' }}>
                    <div className="small fw-semibold mb-1">{m.speaker === 'Agent' ? '🩺 Assistant' : m.speaker === 'You' ? '🧑 You' : m.speaker === 'Alert' ? '⚠️ Alert' : 'ℹ️'}</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.message}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* The single record control + End */}
            <div className="d-grid gap-2 mt-3">
              <button className={`btn btn-lg ${isRecording && !isSpeakingAgent ? 'btn-warning' : 'btn-primary'} d-flex align-items-center justify-content-center gap-2`} onClick={toggleMic}>
                <i className={`fas ${isSpeakingAgent ? 'fa-hand' : isRecording ? 'fa-pause' : 'fa-microphone'}`}></i>
                {isSpeakingAgent ? (language === 'te-IN' ? 'ఆపండి' : language === 'hi-IN' ? 'रोकें' : 'Interrupt') : isRecording ? t.micOff : t.micOn}
              </button>
              <button className="btn btn-outline-danger d-flex align-items-center justify-content-center gap-2" onClick={endSession} disabled={ending}>
                <i className="fas fa-stop"></i>{ending ? t.ending : t.end}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Map a server error code to a short heading.
function titleForError(code?: string): string {
  switch (code) {
    case 'expired': return 'Link expired';
    case 'completed': return 'Already completed';
    case 'revoked': return 'Link cancelled';
    case 'invalid': return 'Invalid link';
    default: return 'Cannot open link';
  }
}

export default PatientIntake;
