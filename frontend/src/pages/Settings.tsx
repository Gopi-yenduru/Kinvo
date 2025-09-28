import React, { useState, useEffect, useRef } from 'react';

interface SettingsConfig {
  provider?: string;
  model: string;
  openaiApiKey: string;
  retellAIApiKey?: string;
  retellAIAgentId?: string;
  medicalInstructions: string;
  voice: string;
  temperature: number;
  id?: number;
}

const Settings: React.FC = () => {
  const [config, setConfig] = useState<SettingsConfig>({
    provider: 'openai',
    model: 'gpt-4o-realtime-preview',
    openaiApiKey: '',
    retellAIApiKey: '',
    retellAIAgentId: '',
    medicalInstructions: '',
    voice: 'alloy',
    temperature: 0.6
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());
  const [defaults, setDefaults] = useState<{[key: string]: any}>({});
  const editorRef = useRef<HTMLDivElement>(null);

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
          retellAIApiKey: data.retellAIApiKey || '',
          retellAIAgentId: data.retellAIAgentId || '',
          medicalInstructions: data.medicalInstructions || '',
          voice: data.voice || 'alloy',
          temperature: data.temperature || 0.7
        });

        // Reset modification tracking - nothing has been modified yet
        setModifiedFields(new Set());
      } else {
        // Fallback to default values
        setConfig({
          model: 'gpt-4o-realtime-preview',
          openaiApiKey: 'Please configure OpenAI API Key',
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
    { value: 'gpt-realtime', label: 'GPT Realtime' }
  ];

  const providerOptions = [
    { value: 'openai', label: 'OpenAI Realtime' },
    { value: 'retellai', label: 'RetellAI' },
    { value: 'vapi', label: 'VAPI' }
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

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="loading-spinner"></div>
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="page-title">
        <h1>⚙️ System Settings</h1>
        <p>Configure system parameters and view current configuration</p>
      </div>

      {(error || successMessage) && (
        <div className={`settings-message ${error ? 'error' : 'success'}`}>
          <div className="message-icon">{error ? '⚠️' : '✅'}</div>
          <div className="message-content">
            <p>{error || successMessage}</p>
          </div>
        </div>
      )}

      <div className="settings-content">
        {/* Provider Selection */}
        <div className="settings-section">
          <div className="section-header">
            <h2>🏢 AI Provider Selection</h2>
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

        {/* OpenAI-specific sections */}
        {config.provider === 'openai' && (
          <>
            {/* AI Model Configuration */}
            <div className="settings-section">
              <div className="section-header">
                <h2>🤖 AI Model Configuration</h2>
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

            {/* System Prompt Configuration */}
            <div className="settings-section">
              <div className="section-header">
                <h2>🏥 System Prompt</h2>
                <div className="section-description">
                  Configure the medical intake system prompt and guidelines
                </div>
              </div>
              <div className="settings-field">
                <label className="field-label">
                  Medical Intake Instructions
                  {config.medicalInstructions && config.medicalInstructions === defaults.medicalInstructions && !modifiedFields.has('medicalInstructions') && (
                    <span className="field-indicator default-indicator">📋 Default</span>
                  )}
                  {modifiedFields.has('medicalInstructions') && (
                    <span className="field-indicator user-indicator">✏️ Modified</span>
                  )}
                </label>

                {/* Rich Text Formatting Toolbar */}
                <div className="rich-text-toolbar">
                  <button
                    type="button"
                    className="format-btn"
                    onClick={() => formatText('bold')}
                    title="Bold"
                  >
                    <strong>B</strong>
                  </button>
                  <button
                    type="button"
                    className="format-btn"
                    onClick={() => formatText('italic')}
                    title="Italic"
                  >
                    <em>I</em>
                  </button>
                  <button
                    type="button"
                    className="format-btn"
                    onClick={() => formatText('underline')}
                    title="Underline"
                  >
                    <u>U</u>
                  </button>
                  <button
                    type="button"
                    className="format-btn"
                    onClick={() => formatText('insertUnorderedList')}
                    title="Bullet List"
                  >
                    •
                  </button>
                  <button
                    type="button"
                    className="format-btn"
                    onClick={() => formatText('insertOrderedList')}
                    title="Numbered List"
                  >
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
                    // Ensure Enter key works for new lines
                    if (e.key === 'Enter') {
                      // Allow default behavior for Enter
                      return;
                    }
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
          </>
        )}

        {/* RetellAI-specific sections */}
        {config.provider === 'retellai' && (
          <div className="settings-section">
            <div className="section-header">
              <h2>🔑 API Configuration</h2>
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
                placeholder="Enter your RetellAI API key..."
              />
              <div className="field-meta">
                <div className="apikey-status">
                  <span className={config.retellAIApiKey ? 'status-valid' : 'status-invalid'}>
                    {config.retellAIApiKey ? '✅ API Key Configured' : '❌ API Key Required'}
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
                  {config.retellAIAgentId ? '✅ Agent ID Configured' : '❌ Agent ID Required'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* VAPI placeholder */}
        {config.provider === 'vapi' && (
          <div className="settings-section">
            <div className="section-header">
              <h2>🔑 API Configuration</h2>
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
        <div className="settings-actions">
          <button
            className="btn btn-primary save-btn"
            onClick={handleSave}
            disabled={saving || (config.provider === 'openai' && !config.openaiApiKey) || (config.provider === 'retellai' && (!config.retellAIApiKey || !config.retellAIAgentId))}
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