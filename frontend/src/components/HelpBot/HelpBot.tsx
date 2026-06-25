import { useEffect, useRef, useState } from 'react';

/**
 * HelpBot — a floating, multilingual help assistant available on every screen.
 * Answers patient/staff questions ABOUT THE APP by text or voice, in English, Hindi or
 * Telugu. Backed by the grounded /api/assistant/* endpoints (accurate, pre-written
 * answers — never invents). The chosen language is sent to the backend so the reply,
 * the speech (TTS) and the transcription (STT) all match the selected language.
 *
 *  • Text     : type a question → answer in the selected language.
 *  • Voice in : press the mic, speak → transcribed (STT) → answered.
 *  • Voice out: toggle the speaker to hear answers spoken aloud (TTS).
 *
 * Auth: the app's global fetch interceptor attaches the JWT to /api/ calls.
 */

type Lang = 'en-IN' | 'hi-IN' | 'te-IN';
type Msg = { role: 'user' | 'assistant'; text: string };
type Suggestion = { icon: string; label: string; query: string };

const LS_KEY = 'helpbot.lang';
const LANG_ORDER: Lang[] = ['en-IN', 'hi-IN', 'te-IN'];

// Short label shown in the language switcher, plus the full native name (tooltip).
const LANG_META: Record<Lang, { short: string; name: string }> = {
  'en-IN': { short: 'EN', name: 'English' },
  'hi-IN': { short: 'हिं', name: 'हिन्दी' },
  'te-IN': { short: 'తె', name: 'తెలుగు' },
};

// All UI copy + quick-reply suggestions, per language.
const UI: Record<Lang, {
  title: string; subtitle: string; greeting: string; placeholder: string;
  thinking: string; suggestionsTitle: string;
  micError: string; connError: string; noReply: string;
  listen: string; voiceOn: string; voiceOff: string;
  micStart: string; micStop: string; send: string; close: string; help: string;
  suggestions: Suggestion[];
}> = {
  'en-IN': {
    title: 'Help Assistant',
    subtitle: 'Ask about the app — or anything',
    greeting: "Hi! I can help you with this app. Ask me anything — type below, or tap the mic to talk.",
    placeholder: 'Type your question…',
    thinking: 'Thinking…',
    suggestionsTitle: 'Try asking',
    micError: 'Microphone unavailable. Please allow access or type your question.',
    connError: 'Sorry, connection problem. Please try again.',
    noReply: "Sorry, I can't help right now. Please ask the staff.",
    listen: 'Listen', voiceOn: 'Voice on', voiceOff: 'Voice off',
    micStart: 'Speak', micStop: 'Stop', send: 'Send', close: 'Close', help: 'Help',
    suggestions: [
      { icon: 'fa-circle-question', label: 'What is this?', query: 'What does this app do?' },
      { icon: 'fa-shield-halved', label: 'Is my data safe?', query: 'Is my information private and safe?' },
      { icon: 'fa-user-doctor', label: 'Is this a doctor?', query: 'Are you a doctor?' },
      { icon: 'fa-clock', label: 'How long?', query: 'How long does it take?' },
    ],
  },
  'hi-IN': {
    title: 'सहायक',
    subtitle: 'ऐप के बारे में — या कुछ भी पूछें',
    greeting: 'नमस्ते! मैं इस ऐप में आपकी मदद कर सकता हूँ। कुछ भी पूछें — नीचे लिखें, या माइक दबाकर बोलें।',
    placeholder: 'अपना सवाल लिखें…',
    thinking: 'सोच रहा हूँ…',
    suggestionsTitle: 'ये पूछ सकते हैं',
    micError: 'माइक्रोफ़ोन उपलब्ध नहीं है। कृपया अनुमति दें या टाइप करें।',
    connError: 'क्षमा करें, कनेक्शन समस्या। कृपया फिर से प्रयास करें।',
    noReply: 'क्षमा करें, अभी मदद नहीं कर सकता। कृपया कर्मचारियों से पूछें।',
    listen: 'सुनें', voiceOn: 'आवाज़ चालू', voiceOff: 'आवाज़ बंद',
    micStart: 'बोलें', micStop: 'रोकें', send: 'भेजें', close: 'बंद करें', help: 'सहायता',
    suggestions: [
      { icon: 'fa-circle-question', label: 'यह क्या है?', query: 'यह ऐप क्या करता है?' },
      { icon: 'fa-shield-halved', label: 'डेटा सुरक्षित है?', query: 'क्या मेरी जानकारी सुरक्षित है?' },
      { icon: 'fa-user-doctor', label: 'क्या यह डॉक्टर है?', query: 'क्या आप डॉक्टर हैं?' },
      { icon: 'fa-clock', label: 'कितना समय?', query: 'इसमें कितना समय लगता है?' },
    ],
  },
  'te-IN': {
    title: 'సహాయం',
    subtitle: 'యాప్ గురించి — లేదా ఏదైనా అడగండి',
    greeting: 'నమస్కారం! ఈ యాప్ గురించి నేను సహాయం చేస్తాను. ఏదైనా అడగండి — కింద టైప్ చేయొచ్చు, లేదా మైక్ నొక్కి మాట్లాడవచ్చు.',
    placeholder: 'మీ ప్రశ్న టైప్ చేయండి…',
    thinking: 'ఆలోచిస్తోంది…',
    suggestionsTitle: 'ఇవి అడగండి',
    micError: 'మైక్రోఫోన్ అందుబాటులో లేదు. దయచేసి అనుమతి ఇవ్వండి లేదా టైప్ చేయండి.',
    connError: 'క్షమించండి, కనెక్షన్ సమస్య. దయచేసి మళ్ళీ ప్రయత్నించండి.',
    noReply: 'క్షమించండి, ప్రస్తుతం సహాయం అందించలేకపోతున్నాను. దయచేసి సిబ్బందిని అడగండి.',
    listen: 'వినండి', voiceOn: 'వాయిస్ ఆన్', voiceOff: 'వాయిస్ ఆఫ్',
    micStart: 'మాట్లాడండి', micStop: 'ఆపండి', send: 'పంపండి', close: 'మూసివేయండి', help: 'సహాయం',
    suggestions: [
      { icon: 'fa-circle-question', label: 'ఇది ఏమిటి?', query: 'ఈ యాప్ ఏం చేస్తుంది?' },
      { icon: 'fa-shield-halved', label: 'డేటా సురక్షితమేనా?', query: 'నా సమాచారం సురక్షితంగా ఉంటుందా?' },
      { icon: 'fa-user-doctor', label: 'ఇది డాక్టరా?', query: 'మీరు డాక్టరా?' },
      { icon: 'fa-clock', label: 'ఎంత సమయం?', query: 'ఇది ఎంత సమయం పడుతుంది?' },
    ],
  },
};

// Self-contained styles (keyframes, custom scrollbar, hover states) injected once.
const STYLE_ID = 'helpbot-styles';
const STYLES = `
@keyframes hbPop { from { opacity:0; transform: translateY(18px) scale(.96); } to { opacity:1; transform:none; } }
@keyframes hbFadeUp { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform:none; } }
@keyframes hbPulse { 0% { box-shadow:0 0 0 0 rgba(124,58,237,.45);} 70%{ box-shadow:0 0 0 16px rgba(124,58,237,0);} 100%{ box-shadow:0 0 0 0 rgba(124,58,237,0);} }
@keyframes hbBounce { 0%,80%,100% { transform: translateY(0); opacity:.4;} 40% { transform: translateY(-5px); opacity:1;} }
@keyframes hbRec { 0%{ box-shadow:0 0 0 0 rgba(239,68,68,.5);} 70%{ box-shadow:0 0 0 10px rgba(239,68,68,0);} 100%{ box-shadow:0 0 0 0 rgba(239,68,68,0);} }
@keyframes hbSpin { to { transform: rotate(360deg);} }
.hb-launcher { animation: hbPulse 2.6s infinite; transition: transform .18s ease, box-shadow .18s ease; }
.hb-launcher:hover { transform: scale(1.08) rotate(-6deg); }
.hb-panel { animation: hbPop .26s cubic-bezier(.16,1,.3,1); }
.hb-row { animation: hbFadeUp .22s ease both; }
.hb-typing span { display:inline-block; width:7px; height:7px; margin:0 2px; border-radius:50%; background:#9333ea; animation: hbBounce 1.3s infinite both; }
.hb-typing span:nth-child(2){ animation-delay:.16s; } .hb-typing span:nth-child(3){ animation-delay:.32s; }
.hb-scroll::-webkit-scrollbar { width:6px; } .hb-scroll::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:8px; } .hb-scroll::-webkit-scrollbar-track { background:transparent; }
.hb-chip { transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
.hb-chip:hover { transform: translateY(-2px); box-shadow:0 6px 16px rgba(79,70,229,.18); border-color:#a5b4fc; }
.hb-lang { transition: color .15s ease; }
.hb-rec { animation: hbRec 1.2s infinite; }
.hb-icon-btn { transition: background .15s ease, transform .12s ease; }
.hb-icon-btn:hover { transform: scale(1.12); }
.hb-send { transition: transform .12s ease, opacity .15s ease; }
.hb-send:hover:not(:disabled) { transform: scale(1.08); }
`;

const ACCENT = '#4f46e5';
const GRAD = 'linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#9333ea 100%)';

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function loadLang(): Lang {
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)) as Lang | null;
  return saved && LANG_ORDER.includes(saved) ? saved : 'en-IN';
}

const HelpBot: React.FC = () => {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', text: UI[loadLang()].greeting }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakOn, setSpeakOn] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const t = UI[lang];

  // Inject styles once.
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 200);
  }, [open]);

  // Switching language resets the conversation to a fresh greeting in that language
  // (prior answers are in the old language, so a clean restart is clearest).
  const changeLang = (next: Lang) => {
    if (next === lang) return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setLang(next);
    try { localStorage.setItem(LS_KEY, next); } catch { /* ignore */ }
    setMessages([{ role: 'assistant', text: UI[next].greeting }]);
    setInput('');
  };

  const speak = async (text: string) => {
    try {
      const res = await fetch('/api/assistant/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: lang }),
      });
      if (!res.ok) return;
      const { audio } = await res.json();
      if (!audio) return;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      const el = new Audio(`data:audio/wav;base64,${audio}`);
      audioRef.current = el;
      el.play().catch(() => {});
    } catch { /* ignore playback errors */ }
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;
    setInput('');
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    setLoading(true);
    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, history, language: lang }),
      });
      const data = await res.json();
      const reply = data.reply || t.noReply;
      setMessages((prev) => [...prev, { role: 'assistant', text: reply }]);
      if (speakOn) void speak(reply);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: t.connError }]);
    } finally {
      setLoading(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        setRecording(false);
        if (blob.size < 800) return; // too short / silence
        setLoading(true);
        try {
          const b64 = arrayBufferToBase64(await blob.arrayBuffer());
          const res = await fetch('/api/assistant/transcribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: b64, mime: rec.mimeType || 'audio/webm', language: lang }),
          });
          const data = await res.json();
          setLoading(false);
          if (data.text && data.text.trim()) await ask(data.text.trim());
        } catch {
          setLoading(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: t.micError }]);
    }
  };

  const toggleRecording = () => {
    if (recording) recorderRef.current?.stop();
    else void startRecording();
  };

  const showSuggestions = messages.length <= 1 && !loading;

  return (
    <>
      {/* Floating launcher button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="hb-launcher"
          title={t.help}
          style={{
            position: 'fixed', bottom: 24, right: 24, zIndex: 1080,
            width: 62, height: 62, borderRadius: '50%', border: 'none',
            background: GRAD, color: '#fff', cursor: 'pointer', fontSize: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Open help assistant"
        >
          <i className="fas fa-comment-dots" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div
          className="hb-panel"
          style={{
            position: 'fixed', bottom: 24, right: 24, zIndex: 1080,
            width: 'min(390px, calc(100vw - 32px))', height: 'min(610px, calc(100vh - 48px))',
            display: 'flex', flexDirection: 'column',
            background: '#fff', borderRadius: 20, overflow: 'hidden',
            boxShadow: '0 24px 60px rgba(30,27,75,0.35)', border: '1px solid rgba(148,163,184,0.25)',
          }}
        >
          {/* Header */}
          <div style={{ background: GRAD, color: '#fff', padding: '14px 16px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
              }}>
                <i className="fas fa-headset" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 7 }}>
                  {t.title}
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', background: '#4ade80',
                    boxShadow: '0 0 0 3px rgba(74,222,128,0.3)', display: 'inline-block',
                  }} />
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subtitle}</div>
              </div>
              <button onClick={() => setSpeakOn((v) => !v)} title={speakOn ? t.voiceOn : t.voiceOff}
                className="hb-icon-btn"
                style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16, width: 30, height: 30, borderRadius: 8 }}
                aria-label="Toggle voice answers">
                <i className={`fas ${speakOn ? 'fa-volume-high' : 'fa-volume-xmark'}`} />
              </button>
              <button onClick={() => setOpen(false)} title={t.close}
                className="hb-icon-btn"
                style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18, width: 30, height: 30, borderRadius: 8 }}
                aria-label="Close">
                <i className="fas fa-xmark" />
              </button>
            </div>

            {/* Language switcher */}
            <div style={{
              marginTop: 11, display: 'flex', gap: 3, padding: 3,
              background: 'rgba(255,255,255,0.16)', borderRadius: 10,
            }}>
              {LANG_ORDER.map((l) => {
                const active = l === lang;
                return (
                  <button key={l} onClick={() => changeLang(l)} title={LANG_META[l].name}
                    className="hb-lang"
                    style={{
                      flex: 1, border: 'none', cursor: 'pointer', borderRadius: 8, padding: '5px 0',
                      fontSize: 12.5, fontWeight: 700, letterSpacing: 0.2,
                      background: active ? '#fff' : 'transparent',
                      color: active ? ACCENT : 'rgba(255,255,255,0.9)',
                      boxShadow: active ? '0 2px 6px rgba(0,0,0,0.15)' : 'none',
                    }}
                    aria-pressed={active}
                  >
                    {LANG_META[l].short}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Messages */}
          <div ref={listRef} className="hb-scroll" style={{ flex: 1, overflowY: 'auto', padding: 14, background: 'linear-gradient(180deg,#f8fafc,#f1f5f9)' }}>
            {messages.map((m, i) => {
              const isUser = m.role === 'user';
              return (
                <div key={i} className="hb-row" style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 7, marginBottom: 11 }}>
                  {!isUser && (
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: GRAD,
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                    }}>
                      <i className="fas fa-headset" />
                    </div>
                  )}
                  <div style={{
                    maxWidth: '78%', padding: '9px 13px', fontSize: 14, lineHeight: 1.5,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: isUser ? GRAD : '#fff',
                    color: isUser ? '#fff' : '#1f2937',
                    border: isUser ? 'none' : '1px solid #e5e7eb',
                    boxShadow: isUser ? '0 4px 12px rgba(79,70,229,0.25)' : '0 1px 3px rgba(0,0,0,0.06)',
                  }}>
                    {m.text}
                    {!isUser && i > 0 && (
                      <button onClick={() => void speak(m.text)} title={t.listen}
                        style={{ background: 'transparent', border: 'none', color: ACCENT, cursor: 'pointer', marginLeft: 6, fontSize: 12, padding: 0 }}
                        aria-label="Play answer">
                        <i className="fas fa-volume-high" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="hb-row" style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'flex-end', gap: 7, marginBottom: 11 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: GRAD,
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                }}>
                  <i className="fas fa-headset" />
                </div>
                <div style={{ padding: '11px 14px', borderRadius: '16px 16px 16px 4px', background: '#fff', border: '1px solid #e5e7eb' }}>
                  <span className="hb-typing"><span /><span /><span /></span>
                </div>
              </div>
            )}

            {/* Quick-reply suggestions (only on a fresh conversation) */}
            {showSuggestions && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', margin: '4px 4px 8px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {t.suggestionsTitle}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {t.suggestions.map((sg, i) => (
                    <button key={i} onClick={() => void ask(sg.query)} className="hb-chip"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20,
                        padding: '7px 13px', fontSize: 12.5, color: '#334155', fontWeight: 500,
                      }}>
                      <i className={`fas ${sg.icon}`} style={{ color: ACCENT, fontSize: 12 }} />
                      {sg.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #eef2f7', background: '#fff', alignItems: 'center' }}>
            <button onClick={toggleRecording} disabled={loading} title={recording ? t.micStop : t.micStart}
              className={recording ? 'hb-rec' : 'hb-icon-btn'}
              style={{
                width: 42, height: 42, flexShrink: 0, borderRadius: '50%', cursor: loading ? 'not-allowed' : 'pointer',
                border: 'none', background: recording ? '#ef4444' : '#f1f5f9', color: recording ? '#fff' : '#475569', fontSize: 15,
              }}
              aria-label="Speak">
              <i className={`fas ${recording ? 'fa-stop' : 'fa-microphone'}`} />
            </button>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask(input); }}
              placeholder={t.placeholder}
              disabled={loading || recording}
              style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 22, padding: '10px 16px', fontSize: 14, outline: 'none', background: '#f8fafc', color: '#1f2937' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = ACCENT; e.currentTarget.style.background = '#fff'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.background = '#f8fafc'; }}
            />
            <button onClick={() => void ask(input)} disabled={loading || recording || !input.trim()} title={t.send}
              className="hb-send"
              style={{
                width: 42, height: 42, flexShrink: 0, borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: GRAD, color: '#fff', fontSize: 15, opacity: (loading || recording || !input.trim()) ? 0.45 : 1,
              }}
              aria-label="Send">
              <i className="fas fa-paper-plane" />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default HelpBot;
