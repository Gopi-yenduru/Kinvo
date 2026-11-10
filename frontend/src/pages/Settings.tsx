import React, { useState, useEffect, useRef } from 'react';

type EngineChoice = { stt: string; llm: string; tts: string };
type EngineMap = { [lang: string]: EngineChoice };

// Mirrors backend/src/advanced-config.ts. Every field is always present (the backend returns a
// fully-resolved config), so the controls can bind directly without null checks.
interface AdvancedConfig {
  llm: { temperature: number; maxResponseTokens: number; frequencyPenalty: number; presencePenalty: number };
  humanization: { timingJitter: boolean; paceJitter: boolean; breaths: boolean; noiseBed: boolean; telephonyEq: boolean };
  fillers: { enabled: boolean; delayMs: number };
  tts: { sarvamTemperature: number | null; speakerTe: string; speakerHi: string; speakerEn: string };
  stt: { vadRms: number; silenceHangMs: number; minSpeechMs: number; maxUtteranceMs: number; noiseResetMs: number };
  turnTaking: { resumeAfterInterruptMs: number; floorSettleMs: number; noEndSignalFallbackMs: number };
}

// Fallback used only until the backend config loads (it then replaces this with the real values).
const DEFAULT_ADVANCED: AdvancedConfig = {
  llm: { temperature: 0.6, maxResponseTokens: 220, frequencyPenalty: 0.6, presencePenalty: 0.3 },
  humanization: { timingJitter: true, paceJitter: true, breaths: true, noiseBed: true, telephonyEq: false },
  fillers: { enabled: true, delayMs: 350 },
  tts: { sarvamTemperature: null, speakerTe: '', speakerHi: '', speakerEn: '' },
  stt: { vadRms: 0.035, silenceHangMs: 500, minSpeechMs: 450, maxUtteranceMs: 20000, noiseResetMs: 1200 },
  turnTaking: { resumeAfterInterruptMs: 3500, floorSettleMs: 450, noEndSignalFallbackMs: 2500 },
};

// Sarvam Bulbul v3 speakers (warm, natural; infer emotion from text + pace). '' = use the Voice setting.
const SARVAM_SPEAKERS = ['', 'neha', 'priya', 'kavya', 'simran', 'ritu', 'pooja', 'anushka', 'aditya', 'rahul', 'rohan'];

interface SettingsConfig {
  provider?: string;
  model: string;
  openaiApiKey: string;              // always '' from the backend (keys are never sent); a typed value replaces the stored key
  openaiApiKeyConfigured?: boolean;
  retellAIApiKey?: string;
  retellAIApiKeyConfigured?: boolean;
  retellAIAgentId?: string;
  medicalInstructions: string;
  voice: string;
  temperature: number;
  engineMap?: EngineMap;
  advanced?: AdvancedConfig;
  id?: number;
}

// Per-language STT/LLM/TTS engine mapping is configurable for Telugu & Hindi (English keeps
// built-in defaults). Option lists mirror what the Sarvam pipeline actually supports today.
const MAPPED_LANGUAGES: { code: string; label: string }[] = [
  { code: 'te-IN', label: 'Telugu' },
  { code: 'hi-IN', label: 'Hindi' }
];
const STT_ENGINE_OPTIONS = [
  { value: 'sarvam', label: 'Sarvam (saaras)' },
  { value: 'openai', label: 'OpenAI (coming soon)', disabled: true },
  { value: 'elevenlabs', label: 'ElevenLabs (coming soon)', disabled: true }
];
const LLM_ENGINE_OPTIONS = [
  { value: 'sarvam', label: 'Sarvam (sarvam-30b)' },
  { value: 'openai', label: 'OpenAI (gpt-4o)' }
];
const TTS_ENGINE_OPTIONS = [
  { value: 'sarvam', label: 'Sarvam (bulbul)' },
  { value: 'openai', label: 'OpenAI (gpt-4o-mini-tts)' },
  { value: 'elevenlabs', label: 'ElevenLabs' }
];
// Open Indic engines for the LiveKit provider (Telugu/Hindi). These route to the separate
// indic-voice-service; Sarvam stays the default + automatic fallback if it isn't running.
const LIVEKIT_STT_OPTIONS = [
  { value: 'sarvam', label: 'Sarvam (saaras)' },
  { value: 'indic-conformer', label: 'IndicConformer (open)' },
  { value: 'indic-whisper', label: 'IndicWhisper (open)' }
];
const LIVEKIT_TTS_OPTIONS = [
  { value: 'sarvam', label: 'Sarvam (bulbul)' },
  { value: 'parler', label: 'Indic Parler-TTS (open)' }
];
const DEFAULT_ENGINE_MAP: EngineMap = {
  'te-IN': { stt: 'sarvam', llm: 'sarvam', tts: 'sarvam' },
  'hi-IN': { stt: 'sarvam', llm: 'sarvam', tts: 'openai' }
};

const Settings: React.FC = () => {
  const [config, setConfig] = useState<SettingsConfig>({
    provider: 'openai',
    model: 'gpt-4o-realtime-preview',
    openaiApiKey: '',
    retellAIApiKey: '',
    retellAIAgentId: '',
    medicalInstructions: '',
    voice: 'alloy',
    temperature: 0.6,
    engineMap: DEFAULT_ENGINE_MAP,
    advanced: DEFAULT_ADVANCED
  });
  const [advancedMode, setAdvancedMode] = useState<boolean>(() => {
    try { return localStorage.getItem('kinvo.settings.advanced') === '1'; } catch { return false; }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());
  const [defaults, setDefaults] = useState<{[key: string]: any}>({});
  const editorRef = useRef<HTMLDivElement>(null);

  // Saving is admin-only on the backend (a 403 would also clear the login via the fetch
  // interceptor), so non-admins get a read-only page.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; }
  })();

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      setError('');
      // Fetch configuration from backend
      const response = await fetch('/api/settings/config', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.ok) {
        const data = await response.json();

        // Store the defaults from the backend (.env + constants)
        const backendDefaults = {
          openaiApiKey: data.openaiApiKey || '',
          medicalInstructions: data.medicalInstructions || ''
        };
        setDefaults(backendDefaults);

        // Load stored settings if they exist, otherwise use defaults
        setConfig({
          id: data.id,
          provider: data.provider || 'openai',
          model: data.model || 'gpt-4o-realtime-preview',
          openaiApiKey: data.openaiApiKey || '',
          openaiApiKeyConfigured: !!data.openaiApiKeyConfigured,
          retellAIApiKey: data.retellAIApiKey || '',
          retellAIApiKeyConfigured: !!data.retellAIApiKeyConfigured,
          retellAIAgentId: data.retellAIAgentId || '',
          medicalInstructions: data.medicalInstructions || '',
          voice: data.voice || 'alloy',
          temperature: data.temperature || 0.7,
          engineMap: { ...DEFAULT_ENGINE_MAP, ...(data.engineMap || {}) },
          advanced: data.advanced ? (data.advanced as AdvancedConfig) : DEFAULT_ADVANCED
        });

        // Reset modification tracking - nothing has been modified yet
        setModifiedFields(new Set());
      } else {
        // Fallback to default values
        setConfig({
          model: 'gpt-4o-realtime-preview',
          openaiApiKey: '',
          medicalInstructions: 'Unable to load default medical instructions. Please check your connection to the backend service.',
          voice: 'alloy',
          temperature: 0.6
        });
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      setError('Failed to load settings configuration');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccessMessage('');

      const response = await fetch('/api/settings/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        const savedData = await response.json();
        setConfig(savedData);
        setSuccessMessage('Settings saved successfully!');
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        const errorData = await response.json();
        setError(errorData.message || 'Failed to save settings');
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const sanitizeInstructions = (text: string): string => {
    if (!text || text.trim().length === 0) {
      return '';
    }

    // Basic sanitization - remove excessive whitespace
    let sanitized = text.trim();

    // Remove potential control characters that could break JSON
    sanitized = sanitized.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // Test JSON serialization to catch encoding issues early
    try {
      JSON.stringify({ test: sanitized });
    } catch (e) {
      console.warn('Invalid characters detected in instructions, attempting to clean...');
      // Remove any remaining problematic characters
      sanitized = sanitized.replace(/["\\]/g, (match) => `\\${match}`);
    }

    return sanitized;
  };

  const validateInstructions = (text: string): { isValid: boolean; error?: string } => {
    if (text.length > 10000) {
      return { isValid: false, error: 'Instructions are too long (max 10000 characters)' };
    }
    return { isValid: true };
  };

  const formatText = (command: string, value?: string) => {
    document.execCommand(command, false, value);
  };

  const getPlainText = (html: string): string => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.textContent || tempDiv.innerText || '';
  };

  const handleInputChange = (field: keyof SettingsConfig, value: string | number) => {
    // Special handling for medical instructions
    if (field === 'medicalInstructions') {
      const stringValue = value as string;
      const validation = validateInstructions(stringValue);

      if (!validation.isValid) {
        setError(validation.error || 'Invalid input');
        return;
      }

      // Sanitize the input
      const sanitizedValue = sanitizeInstructions(stringValue);
      value = sanitizedValue;
    }

    // Track that this field has been modified by the user
    setModifiedFields(prev => new Set([...prev, field]));

    setConfig(prev => ({
      ...prev,
      [field]: value
    }));

    // Clear any previous errors
    if (error) setError('');
  };


  // Update one field inside a group of the advanced config (e.g. ('humanization','breaths', true)).
  const setAdv = (group: keyof AdvancedConfig, key: string, value: any) => {
    setModifiedFields(prev => new Set([...prev, 'advanced']));
    setConfig(prev => {
      const base = prev.advanced || DEFAULT_ADVANCED;
      return { ...prev, advanced: { ...base, [group]: { ...(base[group] as any), [key]: value } } };
    });
    if (error) setError('');
  };

  // Update one engine (stt/llm/tts) for one language in the mapping.
  const handleEngineChange = (lang: string, stage: keyof EngineChoice, value: string) => {
    setModifiedFields(prev => new Set([...prev, 'engineMap']));
    setConfig(prev => {
      const base = prev.engineMap || DEFAULT_ENGINE_MAP;
      const current = base[lang] || DEFAULT_ENGINE_MAP[lang];
      return {
        ...prev,
        engineMap: { ...base, [lang]: { ...current, [stage]: value } }
      };
    });
    if (error) setError('');
  };

  const handleResetToDefaults = () => {
    if (confirm('Are you sure you want to reset all settings to their default values? This will replace your custom configurations with the system defaults.')) {
      setConfig({
        ...config,
        openaiApiKey: defaults.openaiApiKey || '',
        medicalInstructions: defaults.medicalInstructions || ''
      });
      setModifiedFields(new Set()); // Clear all modifications
    }
  };

  const modelOptions = [
    { value: 'gpt-4o-realtime-preview', label: 'GPT-4o Realtime Preview' },
    { value: 'gpt-realtime', label: 'GPT Realtime' },
    { value: 'gpt-realtime-mini', label: 'GPT Realtime Mini' }
  ];

  const providerOptions = [
    { value: 'openai', label: 'OpenAI (English)' },
    { value: 'retellai', label: 'RetellAI' },
    { value: 'sarvam', label: 'Sarvam AI (Telugu)' },
    { value: 'pipecat', label: 'Pipecat (Open Source)' },
    { value: 'livekit', label: 'LiveKit + Chatterbox (Open Source)' }
  ];

  const voiceOptions = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'echo', label: 'Echo' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'marin', label: 'Marin' },
    { value: 'cedar', label: 'Cedar' },
    { value: 'ash', label: 'Ash' },
    { value: 'bellad', label: 'Bellad' },
    { value: 'coral', label: 'Coral' },
    { value: 'sage', label: 'Sage' },
    { value: 'verse', label: 'Verse' }
  ];

  // Sarvam (bulbul) Telugu voices. v3 voices are newer/more natural.
  const sarvamVoiceOptions = [
    { value: 'ritu', label: 'Ritu — sweet natural female (v3)' },
    { value: 'priya', label: 'Priya — calm professional female (v3)' },
    { value: 'neha', label: 'Neha — warm female (v3)' },
    { value: 'shreya', label: 'Shreya — expressive female (v3)' },
    { value: 'pooja', label: 'Pooja — gentle female (v3)' },
    { value: 'vidya', label: 'Vidya — standard female (v2)' },
    { value: 'manisha', label: 'Manisha — standard female (v2)' },
    { value: 'anushka', label: 'Anushka — standard female (v2)' },
    { value: 'aditya', label: 'Aditya — professional male (v3)' },
    { value: 'rahul', label: 'Rahul — calm male (v3)' },
  ];

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="loading-spinner"></div>
        <p>Loading settings...</p>
      </div>
    );
  }

  // Shared System Prompt (medical intake instructions) editor — used by both the OpenAI and
  // Sarvam layouts. Only one provider renders at a time, so reusing the single editorRef is safe.
  const systemPromptSection = (
    <div className="settings-section">
      <div className="section-header">
        <h2><i className="fas fa-notes-medical k-h-icon" aria-hidden="true"></i>System Prompt</h2>
        <div className="section-description">
          Configure the medical intake system prompt and guidelines
        </div>
      </div>
      <div className="settings-field">
        <label className="field-label">
          Medical Intake Instructions
          {config.medicalInstructions && config.medicalInstructions === defaults.medicalInstructions && !modifiedFields.has('medicalInstructions') && (
            <span className="field-indicator default-indicator">Default</span>
          )}
          {modifiedFields.has('medicalInstructions') && (
            <span className="field-indicator user-indicator">Modified</span>
          )}
        </label>

        {/* Rich Text Formatting Toolbar */}
        <div className="rich-text-toolbar">
          <button type="button" className="format-btn" onClick={() => formatText('bold')} title="Bold">
            <strong>B</strong>
          </button>
          <button type="button" className="format-btn" onClick={() => formatText('italic')} title="Italic">
            <em>I</em>
          </button>
          <button type="button" className="format-btn" onClick={() => formatText('underline')} title="Underline">
            <u>U</u>
          </button>
          <button type="button" className="format-btn" onClick={() => formatText('insertUnorderedList')} title="Bullet List">
            •
          </button>
          <button type="button" className="format-btn" onClick={() => formatText('insertOrderedList')} title="Numbered List">
            1.
          </button>
        </div>

        {/* Rich Text Editor */}
        <div
          ref={editorRef}
          className={`field-input instructions-editor ${!config.medicalInstructions ? 'empty' : ''}`}
          contentEditable
          dangerouslySetInnerHTML={{ __html: config.medicalInstructions ? config.medicalInstructions.replace(/\n/g, '<br>') : '<span class="editor-placeholder">Enter the medical intake instructions...</span>' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { return; }
          }}
          onBlur={() => {
            if (editorRef.current) {
              const html = editorRef.current.innerHTML;
              const plainText = getPlainText(html);
              handleInputChange('medicalInstructions', plainText);
            }
          }}
          suppressContentEditableWarning={true}
        />

        <div className="field-meta">
          <span className="character-count">
            {config.medicalInstructions.length} characters
          </span>
          <span className="word-count">
            {config.medicalInstructions.split(/\s+/).filter(word => word.length > 0).length} words
          </span>
        </div>
      </div>
    </div>
  );

  const A = config.advanced || DEFAULT_ADVANCED;

  // Compact labelled range control. `fmt` renders the live value (e.g. "350 ms", "0.60").
  const Slider = (
    label: string, group: keyof AdvancedConfig, key: string, value: number,
    min: number, max: number, step: number, fmt: (v: number) => string, hint?: string
  ) => (
    <div className="adv-field" key={`${group}.${key}`}>
      <div className="adv-field-head">
        <label className="field-label mb-0">{label}</label>
        <span className="adv-value">{fmt(value)}</span>
      </div>
      <input type="range" className="form-range" min={min} max={max} step={step} value={value}
        disabled={!isAdmin}
        onChange={(e) => setAdv(group, key as any, Number(e.target.value) as any)} />
      {hint && <div className="adv-hint">{hint}</div>}
    </div>
  );

  // Toggle row (label + description on the left, switch on the right).
  const Toggle = (label: string, group: keyof AdvancedConfig, key: string, value: boolean, hint: string) => (
    <div className="adv-toggle" key={`${group}.${key}`}>
      <div>
        <div className="adv-toggle-label">{label}</div>
        <div className="adv-hint">{hint}</div>
      </div>
      <div className="form-check form-switch m-0">
        <input className="form-check-input" type="checkbox" role="switch" checked={value}
          disabled={!isAdmin}
          aria-label={label}
          onChange={(e) => setAdv(group, key as any, e.target.checked as any)} />
      </div>
    </div>
  );

  const advancedPanel = (
    <>
      {/* Conversation intelligence (LLM) */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-brain k-h-icon" aria-hidden="true"></i>Conversation Intelligence</h2>
          <div className="section-description">How the language model phrases each reply. Applies to the next session.</div>
        </div>
        <div className="adv-grid">
          {Slider('Creativity (temperature)', 'llm', 'temperature', A.llm.temperature, 0, 1, 0.05,
            (v) => v.toFixed(2), 'Lower = consistent and on-script. Higher = more varied, human phrasing.')}
          {Slider('Max reply length', 'llm', 'maxResponseTokens', A.llm.maxResponseTokens, 40, 1000, 10,
            (v) => `${v} tokens`, 'Caps a single reply — a short empathetic line plus one question.')}
          {Slider('Repetition penalty', 'llm', 'frequencyPenalty', A.llm.frequencyPenalty, -2, 2, 0.1,
            (v) => v.toFixed(1), 'Discourages repeating the same words.')}
          {Slider('Topic variety penalty', 'llm', 'presencePenalty', A.llm.presencePenalty, -2, 2, 0.1,
            (v) => v.toFixed(1), 'Discourages dwelling on the same topic.')}
        </div>
      </div>

      {/* Voice humanization */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-wand-magic-sparkles k-h-icon" aria-hidden="true"></i>Voice Humanization</h2>
          <div className="section-description">Subtle realism layers that stop the agent sounding like a bot.</div>
        </div>
        {Toggle('Response-gap timing jitter', 'humanization', 'timingJitter', A.humanization.timingJitter,
          'Varies the pause before each reply so it is never the same twice.')}
        {Toggle('TTS pace jitter', 'humanization', 'paceJitter', A.humanization.paceJitter,
          'Wobbles the speaking pace per turn so the melody never loops.')}
        {Toggle('Breaths before long replies', 'humanization', 'breaths', A.humanization.breaths,
          'A quiet inhale under the first word of longer replies.')}
        {Toggle('Room-tone noise bed', 'humanization', 'noiseBed', A.humanization.noiseBed,
          'A faint continuous room tone so there is never digital dead silence.')}
        {Toggle('Telephony EQ', 'humanization', 'telephonyEq', A.humanization.telephonyEq,
          'Phone-line band-pass + compression. Off by default — hurts a hi-fi browser voice.')}
      </div>

      {/* Thinking fillers */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-comment-dots k-h-icon" aria-hidden="true"></i>Thinking Fillers</h2>
          <div className="section-description">Short "hmm…/సరే…" clips in the agent's own voice that cover LLM thinking time.</div>
        </div>
        {Toggle('Enable fillers', 'fillers', 'enabled', A.fillers.enabled,
          'Play a short acknowledgement if the real reply has not started in time.')}
        <div className="adv-grid mt-2">
          {Slider('Filler delay', 'fillers', 'delayMs', A.fillers.delayMs, 0, 2000, 50,
            (v) => `${v} ms`, 'How long to wait for the real reply before playing a filler.')}
        </div>
      </div>

      {/* Voice & TTS */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-wave-square k-h-icon" aria-hidden="true"></i>Voice &amp; Speech (TTS)</h2>
          <div className="section-description">Per-language Sarvam speaker and expressive variation.</div>
        </div>
        <div className="adv-grid">
          <div className="adv-field">
            <label className="field-label">Expressiveness (Sarvam v3)</label>
            <div className="adv-field-head">
              <span className="adv-hint m-0">{A.tts.sarvamTemperature == null ? 'Stable (off)' : `Temperature ${A.tts.sarvamTemperature.toFixed(2)}`}</span>
              <div className="form-check form-switch m-0">
                <input className="form-check-input" type="checkbox" role="switch" disabled={!isAdmin}
                  aria-label="Enable expressive variation"
                  checked={A.tts.sarvamTemperature != null}
                  onChange={(e) => setAdv('tts', 'sarvamTemperature', (e.target.checked ? 0.7 : null) as any)} />
              </div>
            </div>
            {A.tts.sarvamTemperature != null && (
              <input type="range" className="form-range mt-1" min={0.01} max={1} step={0.01}
                value={A.tts.sarvamTemperature} disabled={!isAdmin}
                onChange={(e) => setAdv('tts', 'sarvamTemperature', Number(e.target.value) as any)} />
            )}
            <div className="adv-hint">Only applies to Bulbul v3 voices. Higher = more dramatic, less deterministic.</div>
          </div>
          {([['Telugu voice', 'speakerTe'], ['Hindi voice', 'speakerHi'], ['English voice', 'speakerEn']] as const).map(([label, key]) => (
            <div className="adv-field" key={key}>
              <label className="field-label">{label} override</label>
              <select className="form-select" value={(A.tts as any)[key]} disabled={!isAdmin}
                onChange={(e) => setAdv('tts', key as any, e.target.value as any)}>
                {SARVAM_SPEAKERS.map(s => <option key={s || 'default'} value={s}>{s || 'Use Voice setting'}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Speech recognition (English / OpenAI path) */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-ear-listen k-h-icon" aria-hidden="true"></i>Speech Recognition (English)</h2>
          <div className="section-description">End-of-turn detection for the English pipeline. Telugu/Hindi use Sarvam's own VAD.</div>
        </div>
        <div className="adv-grid">
          {Slider('Speech energy floor', 'stt', 'vadRms', A.stt.vadRms, 0.005, 0.2, 0.005,
            (v) => v.toFixed(3), 'Louder than this counts as speech. Raise it in a noisy room.')}
          {Slider('End-of-turn silence', 'stt', 'silenceHangMs', A.stt.silenceHangMs, 150, 2000, 50,
            (v) => `${v} ms`, 'Trailing silence that ends the patient’s turn. Lower = snappier.')}
          {Slider('Minimum speech', 'stt', 'minSpeechMs', A.stt.minSpeechMs, 100, 2000, 50,
            (v) => `${v} ms`, 'Real speech needed before a turn can finalize (rejects blips).')}
          {Slider('Max utterance', 'stt', 'maxUtteranceMs', A.stt.maxUtteranceMs, 5000, 40000, 1000,
            (v) => `${(v / 1000).toFixed(0)} s`, 'Hard cap — force a finalize after this long.')}
          {Slider('Noise reset', 'stt', 'noiseResetMs', A.stt.noiseResetMs, 300, 4000, 100,
            (v) => `${v} ms`, 'Discard a buffer that never became real speech.')}
        </div>
      </div>

      {/* Turn-taking & barge-in */}
      <div className="settings-section">
        <div className="section-header">
          <h2><i className="fas fa-arrows-turn-to-dots k-h-icon" aria-hidden="true"></i>Turn-taking &amp; Barge-in</h2>
          <div className="section-description">How the agent hands over the floor and recovers from false interruptions.</div>
        </div>
        <div className="adv-grid">
          {Slider('Resume after false barge-in', 'turnTaking', 'resumeAfterInterruptMs', A.turnTaking.resumeAfterInterruptMs, 1000, 10000, 250,
            (v) => `${(v / 1000).toFixed(1)} s`, 'If an interruption turns out to be noise, re-ask after this long.')}
          {Slider('Echo-settle window', 'turnTaking', 'floorSettleMs', A.turnTaking.floorSettleMs, 0, 1500, 50,
            (v) => `${v} ms`, 'Ignore the mic briefly after the agent speaks so its own tail is not heard.')}
          {Slider('End-signal fallback', 'turnTaking', 'noEndSignalFallbackMs', A.turnTaking.noEndSignalFallbackMs, 1000, 6000, 250,
            (v) => `${(v / 1000).toFixed(1)} s`, 'Safety net if the speech end-signal never arrives.')}
        </div>
      </div>
    </>
  );

  return (
    <div className="settings-page">
      <div className="page-title d-flex flex-wrap justify-content-between align-items-start gap-3">
        <div>
          <h1>System Settings</h1>
          <p>Configure system parameters and view current configuration</p>
        </div>
        <div className="adv-mode-toggle">
          <div className="form-check form-switch m-0">
            <input className="form-check-input" type="checkbox" role="switch" id="adv-mode"
              checked={advancedMode}
              onChange={(e) => { setAdvancedMode(e.target.checked); try { localStorage.setItem('kinvo.settings.advanced', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
            <label className="form-check-label fw-semibold" htmlFor="adv-mode">Advanced mode</label>
          </div>
          <div className="adv-hint">Expose every engine tuning knob</div>
        </div>
      </div>

      {(error || successMessage) && (
        <div className={`settings-message ${error ? 'error' : 'success'}`}>
          <div className="message-icon"><i className={`fas ${error ? 'fa-circle-exclamation' : 'fa-circle-check'}`} aria-hidden="true"></i></div>
          <div className="message-content">
            <p>{error || successMessage}</p>
          </div>
        </div>
      )}

      <div className="settings-content">
        {/* Provider Selection */}
        <div className="settings-section">
          <div className="section-header">
            <h2><i className="fas fa-microchip k-h-icon" aria-hidden="true"></i>AI Provider Selection</h2>
            <div className="section-description">
              Choose which AI provider to use for voice conversations
            </div>
          </div>
          <div className="settings-field">
            <label className="field-label">Provider</label>
            <select
              className="field-input provider-select"
              value={config.provider}
              onChange={(e) => handleInputChange('provider', e.target.value)}
            >
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Sarvam-specific section (Telugu voice) */}
        {config.provider === 'sarvam' && (
          <div className="settings-section">
            <div className="section-header">
              <h2><i className="fas fa-microphone-lines k-h-icon" aria-hidden="true"></i>Voice (Telugu)</h2>
            </div>
            <div className="settings-field">
              <label className="field-label">Voice</label>
              <select
                className="field-input voice-select"
                value={config.voice}
                onChange={(e) => handleInputChange('voice', e.target.value)}
              >
                {sarvamVoiceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small className="text-muted d-block mt-1">
                "v3" voices are newer and more natural. Changes apply to the next session.
              </small>
            </div>
          </div>
        )}

        {/* Per-language engine mapping (Telugu & Hindi). English keeps built-in defaults. */}
        {config.provider === 'sarvam' && (
          <div className="settings-section">
            <div className="section-header">
              <h2><i className="fas fa-language k-h-icon" aria-hidden="true"></i>Language Engine Mapping</h2>
              <div className="section-description">
                For Telugu and Hindi, map each stage of the voice pipeline — Speech-to-Text,
                the LLM, and Text-to-Speech — to a provider. Changes apply to the next session.
              </div>
            </div>

            {MAPPED_LANGUAGES.map((lng) => {
              const choice = (config.engineMap || DEFAULT_ENGINE_MAP)[lng.code] || DEFAULT_ENGINE_MAP[lng.code];
              return (
                <div key={lng.code} className="engine-map-lang">
                  <h3 className="engine-map-lang-title">{lng.label}</h3>
                  <div className="engine-map-row">
                    <div className="settings-field">
                      <label className="field-label">STT (Speech → Text)</label>
                      <select
                        className="field-input"
                        value={choice.stt}
                        onChange={(e) => handleEngineChange(lng.code, 'stt', e.target.value)}
                      >
                        {STT_ENGINE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} disabled={(o as any).disabled}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="settings-field">
                      <label className="field-label">LLM (Reasoning)</label>
                      <select
                        className="field-input"
                        value={choice.llm}
                        onChange={(e) => handleEngineChange(lng.code, 'llm', e.target.value)}
                      >
                        {LLM_ENGINE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} disabled={(o as any).disabled}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="settings-field">
                      <label className="field-label">TTS (Text → Speech)</label>
                      <select
                        className="field-input"
                        value={choice.tts}
                        onChange={(e) => handleEngineChange(lng.code, 'tts', e.target.value)}
                      >
                        {TTS_ENGINE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} disabled={(o as any).disabled}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
            <small className="text-muted d-block mt-1">
              STT currently supports Sarvam only. OpenAI/ElevenLabs require their API keys to be
              configured on the server; if a key is missing the pipeline falls back to Sarvam.
            </small>
          </div>
        )}

        {/* System Prompt — shown for Sarvam too (at the bottom), same editor as OpenAI. */}
        {config.provider === 'sarvam' && systemPromptSection}

        {/* Pipecat (open source) — fixed engine mapping, runs in the pipecat-service. */}
        {config.provider === 'pipecat' && (
          <>
            <div className="settings-section">
              <div className="section-header">
                <h2><i className="fas fa-diagram-project k-h-icon" aria-hidden="true"></i>Pipecat (Open Source)</h2>
                <div className="section-description">
                  Sessions run through the open-source Pipecat pipeline in the separate
                  Python service (<code>pipecat-service/</code>). It must be running for
                  sessions to start — see its README.
                </div>
              </div>
              <div className="settings-field">
                <div className="alert alert-info mb-0">
                  <strong>Engines:</strong> Telugu/Hindi use Sarvam STT + TTS with a GPT-4o
                  LLM; English is fully OpenAI. Silero VAD handles turn-taking and natural
                  barge-in. Uses the same <code>OPENAI_API_KEY</code> / <code>SARVAM_API_KEY</code>.
                </div>
              </div>
              <div className="settings-field">
                <label className="field-label">Voice (Telugu / Hindi)</label>
                <select
                  className="field-input voice-select"
                  value={config.voice}
                  onChange={(e) => handleInputChange('voice', e.target.value)}
                >
                  {sarvamVoiceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small className="text-muted d-block mt-1">
                  English sessions use OpenAI's "coral" voice. Changes apply to the next session.
                </small>
              </div>
            </div>
            {systemPromptSection}
          </>
        )}

        {/* LiveKit Agents + Chatterbox-Turbo (open source) — runs in the livekit-service. */}
        {config.provider === 'livekit' && (
          <>
            <div className="settings-section">
              <div className="section-header">
                <h2><i className="fas fa-headset k-h-icon" aria-hidden="true"></i>LiveKit Agents + Chatterbox-Turbo (Open Source)</h2>
                <div className="section-description">
                  Sessions run through the open-source LiveKit Agents pipeline in the separate
                  Python service (<code>livekit-service/</code>). It must be running — along
                  with the Chatterbox TTS server — for sessions to start; see its README.
                </div>
              </div>
              <div className="settings-field">
                <div className="alert alert-info mb-0">
                  <strong>Engines:</strong> English is fully <strong>OpenAI</strong> (STT + LLM + TTS).
                  {' '}Telugu &amp; Hindi use <strong>Sarvam</strong> by default, or the open Indic models
                  {' '}below (IndicConformer/IndicWhisper STT, Indic Parler-TTS) when the
                  {' '}<code>indic-voice-service</code> is running. The LLM is GPT-4o; Silero VAD handles
                  {' '}turn-taking and barge-in. Uses the same <code>OPENAI_API_KEY</code> / <code>SARVAM_API_KEY</code>.
                </div>
              </div>
              <div className="settings-field">
                <label className="field-label">Voice (Telugu / Hindi)</label>
                <select
                  className="field-input voice-select"
                  value={config.voice}
                  onChange={(e) => handleInputChange('voice', e.target.value)}
                >
                  {sarvamVoiceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small className="text-muted d-block mt-1">
                  The Sarvam speaker used for Telugu/Hindi when their TTS is set to Sarvam below.
                  English uses OpenAI's voice. Changes apply to the next session.
                </small>
              </div>
            </div>

            {/* Telugu/Hindi open-source STT/TTS engine selection — routes to indic-voice-service. */}
            <div className="settings-section">
              <div className="section-header">
                <h2><i className="fas fa-language k-h-icon" aria-hidden="true"></i>Telugu / Hindi Engines (open source)</h2>
                <div className="section-description">
                  Choose Speech-to-Text and Text-to-Speech for Telugu &amp; Hindi. The Indic models
                  (IndicConformer / IndicWhisper, Indic Parler-TTS) run in the separate
                  {' '}<code>indic-voice-service</code> (GPU recommended) — if it isn't running, sessions
                  {' '}fall back to Sarvam automatically. Changes apply to the next session.
                </div>
              </div>
              {MAPPED_LANGUAGES.map((lng) => {
                const choice = (config.engineMap || DEFAULT_ENGINE_MAP)[lng.code] || DEFAULT_ENGINE_MAP[lng.code];
                const sttVal = LIVEKIT_STT_OPTIONS.some((o) => o.value === choice.stt) ? choice.stt : 'sarvam';
                const ttsVal = LIVEKIT_TTS_OPTIONS.some((o) => o.value === choice.tts) ? choice.tts : 'sarvam';
                return (
                  <div key={lng.code} className="engine-map-lang">
                    <h3 className="engine-map-lang-title">{lng.label}</h3>
                    <div className="engine-map-row">
                      <div className="settings-field">
                        <label className="field-label">STT (Speech → Text)</label>
                        <select
                          className="field-input"
                          value={sttVal}
                          onChange={(e) => handleEngineChange(lng.code, 'stt', e.target.value)}
                        >
                          {LIVEKIT_STT_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="settings-field">
                        <label className="field-label">TTS (Text → Speech)</label>
                        <select
                          className="field-input"
                          value={ttsVal}
                          onChange={(e) => handleEngineChange(lng.code, 'tts', e.target.value)}
                        >
                          {LIVEKIT_TTS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {systemPromptSection}
          </>
        )}

        {/* OpenAI-specific sections */}
        {config.provider === 'openai' && (
          <>
            {/* AI Model Configuration */}
            <div className="settings-section">
              <div className="section-header">
                <h2><i className="fas fa-sliders k-h-icon" aria-hidden="true"></i>AI Model Configuration</h2>
              </div>
              <div className="settings-field">
                <label className="field-label">Model</label>
                <select
                  className="field-input model-select"
                  value={config.model}
                  onChange={(e) => handleInputChange('model', e.target.value)}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Temperature Configuration */}
              <div className="settings-field">
                <label className="field-label">Temperature</label>
                <input
                  type="number"
                  className="field-input temperature-input"
                  value={config.temperature}
                  onChange={(e) => handleInputChange('temperature', parseFloat(e.target.value) || 0)}
                  min="0"
                  max="1"
                  step="0.1"
                  placeholder="0.6"
                />
              </div>

              {/* Voice Configuration */}
              <div className="settings-field">
                <label className="field-label">Voice</label>
                <select
                  className="field-input voice-select"
                  value={config.voice}
                  onChange={(e) => handleInputChange('voice', e.target.value)}
                >
                  {voiceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {systemPromptSection}
          </>
        )}

        {/* RetellAI-specific sections */}
        {config.provider === 'retellai' && (
          <div className="settings-section">
            <div className="section-header">
              <h2><i className="fas fa-key k-h-icon" aria-hidden="true"></i>API Configuration</h2>
              <div className="section-description">
                Configure RetellAI API keys and credentials
              </div>
            </div>

            <div className="settings-field">
              <label className="field-label">RetellAI API Key</label>
              <input
                type="password"
                className="field-input apikey-input"
                value={config.retellAIApiKey || ''}
                onChange={(e) => handleInputChange('retellAIApiKey', e.target.value)}
                placeholder={config.retellAIApiKeyConfigured ? 'Configured — leave blank to keep the current key' : 'Enter your RetellAI API key...'}
              />
              <div className="field-meta">
                <div className="apikey-status">
                  <span className={(config.retellAIApiKey || config.retellAIApiKeyConfigured) ? 'status-valid' : 'status-invalid'}>
                    {(config.retellAIApiKey || config.retellAIApiKeyConfigured) ? 'API key configured' : 'API key required'}
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-field">
              <label className="field-label">RetellAI Agent ID</label>
              <input
                type="text"
                className="field-input"
                value={config.retellAIAgentId || ''}
                onChange={(e) => handleInputChange('retellAIAgentId', e.target.value)}
                placeholder="Enter your RetellAI Agent ID..."
              />
              <div className="field-meta">
                <span className={config.retellAIAgentId ? 'status-valid' : 'status-invalid'}>
                  {config.retellAIAgentId ? 'Agent ID configured' : 'Agent ID required'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* VAPI placeholder */}
        {config.provider === 'vapi' && (
          <div className="settings-section">
            <div className="section-header">
              <h2><i className="fas fa-key k-h-icon" aria-hidden="true"></i>API Configuration</h2>
              <div className="section-description">
                Configure VAPI API keys and credentials
              </div>
            </div>
            <div className="settings-field">
              <div className="alert alert-info">
                <strong>Coming Soon:</strong> VAPI integration is planned but not yet implemented.
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {/* Advanced control panel — every fine-grained engine knob, revealed by the toggle above. */}
        {advancedMode && (
          <div className="adv-panel">
            <div className="adv-panel-banner">
              <i className="fas fa-sliders" aria-hidden="true"></i>
              <div>
                <strong>Advanced engine tuning</strong>
                <div className="adv-hint">These apply to the Sarvam/OpenAI voice pipeline on the next session started. Defaults are safe — only change what you understand.</div>
              </div>
            </div>
            {advancedPanel}
          </div>
        )}

        {!isAdmin && (
          <div className="alert alert-info">Only administrators can change settings.</div>
        )}
        <div className="settings-actions">
          <button
            className="btn btn-primary save-btn"
            onClick={handleSave}
            disabled={!isAdmin || saving
              || (config.provider === 'openai' && !config.openaiApiKey && !config.openaiApiKeyConfigured)
              || (config.provider === 'retellai' && ((!config.retellAIApiKey && !config.retellAIApiKeyConfigured) || !config.retellAIAgentId))}
          >
             <i className="fas fa-save me-2"></i>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>

          <button
            className="btn btn-secondary reset-btn"
            onClick={handleResetToDefaults}
            disabled={modifiedFields.size === 0}
            title="Reset to default values from .env and constants"
          >
             <i className="fas fa-refresh me-2"></i>
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;
