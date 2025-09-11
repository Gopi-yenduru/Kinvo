import React, { useState, useEffect } from 'react';

interface SettingsConfig {
  model: string;
  openaiApiKey: string;
  medicalInstructions: string;
  id?: number;
}

const Settings: React.FC = () => {
  const [config, setConfig] = useState<SettingsConfig>({
    model: 'gpt-4o-realtime-preview',
    openaiApiKey: '',
    medicalInstructions: ''
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());
  const [defaults, setDefaults] = useState<{[key: string]: any}>({});

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      setError('');
      // Fetch configuration from backend
      const response = await fetch('http://localhost:3001/api/settings/config', {
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
          model: data.model || 'gpt-4o-realtime-preview',
          openaiApiKey: data.openaiApiKey || '',
          medicalInstructions: data.medicalInstructions || ''
        });

        // Reset modification tracking - nothing has been modified yet
        setModifiedFields(new Set());
      } else {
        // Fallback to default values
        setConfig({
          model: 'gpt-4o-realtime-preview',
          openaiApiKey: 'Please configure OpenAI API Key',
          medicalInstructions: 'Unable to load default medical instructions. Please check your connection to the backend service.'
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

      const response = await fetch('http://localhost:3001/api/settings/config', {
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

  const handleInputChange = (field: keyof SettingsConfig, value: string) => {
    // Track that this field has been modified by the user
    setModifiedFields(prev => new Set([...prev, field]));

    setConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const maskApiKey = (key: string) => {
    if (!key || key.length <= 10) return key;
    return key.substring(0, 6) + '************************' + key.substring(key.length - 4);
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
        {/* AI Model Configuration */}
        <div className="settings-section">
          <div className="section-header">
            <h2>🤖 AI Model Configuration</h2>
            <div className="section-description">
              Select the AI model used for real-time voice processing and system prompts
            </div>
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
            <textarea
              className="field-input instructions-textarea"
              value={config.medicalInstructions}
              onChange={(e) => handleInputChange('medicalInstructions', e.target.value)}
              placeholder="Enter the medical intake instructions..."
              rows={20}
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

        {/* API Configuration */}
        <div className="settings-section">
          <div className="section-header">
            <h2>🔑 API Configuration</h2>
            <div className="section-description">
              Configure external API keys and credentials
            </div>
          </div>
          <div className="settings-field">
            <label className="field-label">
              OpenAI API Key
              {config.openaiApiKey && config.openaiApiKey === defaults.openaiApiKey && !modifiedFields.has('openaiApiKey') && (
                <span className="field-indicator default-indicator">📋 Default (.env)</span>
              )}
              {modifiedFields.has('openaiApiKey') && (
                <span className="field-indicator user-indicator">✏️ Modified</span>
              )}
            </label>
            <input
              type="password"
              className="field-input apikey-input"
              value={config.openaiApiKey}
              onChange={(e) => handleInputChange('openaiApiKey', e.target.value)}
              placeholder="Enter your OpenAI API key..."
            />
            <div className="field-meta">
              <div className="apikey-status">
                <span className={config.openaiApiKey ? 'status-valid' : 'status-invalid'}>
                  {config.openaiApiKey ? '✅ API Key Configured' : '❌ API Key Required'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="settings-actions">
          <button
            className="btn btn-primary save-btn"
            onClick={handleSave}
            disabled={saving || !config.openaiApiKey}
          >
            {saving ? '💾 Saving...' : '💾 Save Settings'}
          </button>

          <button
            className="btn btn-secondary reset-btn"
            onClick={handleResetToDefaults}
            disabled={modifiedFields.size === 0}
            title="Reset to default values from .env and constants"
          >
            🔄 Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;