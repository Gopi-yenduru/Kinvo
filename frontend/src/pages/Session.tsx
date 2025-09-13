import React, { useState, useEffect, useRef } from 'react';

type SessionStatus = 'idle' | 'connecting' | 'active' | 'completed' | 'error';

interface Message {
  timestamp: string;
  speaker: string;
  message: string;
  type?: 'text' | 'audio' | 'system' | 'alert';
}

const Session: React.FC = () => {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>('Disconnected');
  const [conversationLog, setConversationLog] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [sessionDuration, setSessionDuration] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [pendingSentence, setPendingSentence] = useState<{speaker: string, text: string, timeoutId: number, timestamp?: string} | null>(null);

  // New state for patient name input
  const [patientName, setPatientName] = useState<string>('');
  const [showPatientForm, setShowPatientForm] = useState<boolean>(false);
  const pendingSentenceRef = useRef<{speaker: string, text: string, timeoutId: number, timestamp?: string} | null>(null);

  const conversationMessagesRef = useRef<HTMLDivElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const sessionStartTime = useRef<number | null>(null);
  const audioBufferRef = useRef<string>(''); // Buffer for incoming audio chunks
  const playbackQueueRef = useRef<string[]>([]); // Queue for audio playback

  // Timer effect
  useEffect(() => {
    let interval: number;
    if (sessionStatus === 'active' && sessionStartTime.current) {
      interval = setInterval(() => {
        setSessionDuration(Math.floor((Date.now() - sessionStartTime.current!) / 1000));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [sessionStatus]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const startSession = async (patientNameToUse: string) => {
    try {
      setSessionStatus('connecting');
      setErrorMessage('');
      sessionStartTime.current = Date.now();

      const response = await fetch('http://localhost:3001/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientName: patientNameToUse }),
      });

      const data = await response.json();

      if (data.sessionId) {
        setSessionId(data.sessionId);
        setSessionStatus('active');
        setConversationLog([{
          timestamp: new Date().toLocaleTimeString(),
          speaker: 'System',
          message: 'Welcome to the Medical Intake Voice Agent. Please speak clearly and provide detailed information about your medical concerns.',
          type: 'system'
        }]);
        await initializeAudioRecording();
        connectWebSocket(data.sessionId);
      } else {
        setErrorMessage('Failed to start session');
        setSessionStatus('error');
      }
    } catch (error) {
      console.error('Failed to start session:', error);
      setErrorMessage('Unable to connect to backend. Please check if the server is running.');
      setSessionStatus('error');
    }
  };

  const initializeAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(audioContext.destination);
      gainNodeRef.current = gainNode;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        if (!isRecordingRef.current) return;

        const audioBuffer = event.inputBuffer;
        const monoChannel = audioBuffer.getChannelData(0);
        const pcm16Data = new Int16Array(monoChannel.length);
        
        for (let i = 0; i < monoChannel.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, monoChannel[i] * 32767));
        }

        sendAudioChunk(pcm16Data);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      const sendAudioChunk = (pcmData: Int16Array) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            const pcmArray = Array.from(pcmData);
            wsRef.current.send(JSON.stringify({
              type: 'audio_data',
              data: { pcm16: pcmArray, timestamp: Date.now() }
            }));
          } catch (error) {
            console.error('Failed to send audio chunk:', error);
          }
        }
      };

      setIsRecording(true);
      isRecordingRef.current = true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      setErrorMessage('Failed to initialize audio processing. Please allow microphone access.');
      setSessionStatus('error');
    }
  };

  const connectWebSocket = (sessionId: string) => {
    try {
      wsRef.current = new WebSocket('ws://localhost:3001');

      wsRef.current.onopen = () => {
        setConnectionStatus('Connected');
        wsRef.current?.send(JSON.stringify({
          type: 'join_session',
          sessionId: sessionId
        }));
      };

      wsRef.current.onmessage = (event) => {
        const message = JSON.parse(event.data);

        console.log('📨 Frontend received WS message:', message.type, message);

        switch (message.type) {
          case 'session_joined':
            addToConversationLog('System', message.message || 'Voice agent ready to begin intake', 'system');
            break;
          case 'agent_speech':
            // Handle legacy agent speech messages - DISABLED to avoid conflict with agent_transcript_delta
            // if (message.text) {
            //   if (!checkImmediateSentence('Agent', message.text) && message.text.trim()) {
            //     processTranscriptDelta('Agent', message.text);
            //   }
            // }
            break;
          case 'agent_transcript_delta':
            // Handle agent transcript deltas from backend
            console.log('🎵 Frontend received agent_transcript_delta:', message.text);
            if (message.text && message.text.trim()) {
              console.log('📝 Processing agent delta:', message.text);
              // For agent deltas, always accumulate - don't check immediate sentence first
              // The backend will tell us when the response is complete
              processTranscriptDelta('Agent', message.text, message.timestamp);
            } else {
              console.log('⚠️ Agent transcript delta is empty or null:', message);
            }
            break;
          case 'response.audio_transcript.delta':
            // Handle OpenAI's response.audio_transcript.delta - DISABLED to prevent double processing
            // Use 'agent_transcript_delta' from backend instead
            // if (message.delta && message.delta.trim()) {
            //   processTranscriptDelta('Agent', message.delta);
            // }
            break;
          case 'agent_transcript_complete':
            // Handle complete agent transcripts
            if (message.transcript) {
              // Clear any pending agent sentence first
              if (pendingSentence && pendingSentence.speaker === 'Agent') {
                clearTimeout(pendingSentence.timeoutId);
                setPendingSentence(null);
              }
              // Add complete transcript directly
              addSentenceToConversationLog('Agent', message.transcript, 'text', message.timestamp);
            }
            break;
          case 'conversation.item.input_audio_transcription.delta':
            if (message.delta) {
              // Handle patient transcript deltas
              if (!checkImmediateSentence('You', message.delta) && message.delta.trim()) {
                processTranscriptDelta('You', message.delta);
              }
            }
            break;
          case 'response.content_part.done':
            // Handle complete transcript from OpenAI (more reliable than delta accumulation)
            if (message.part && message.part.transcript && message.part.type === 'audio') {
              // Clear any pending agent sentences since we have the complete transcript
              if (pendingSentence && pendingSentence.speaker === 'Agent') {
                clearTimeout(pendingSentence.timeoutId);
                setPendingSentence(null);
              }
              // Add the complete transcript directly
              addSentenceToConversationLog('Agent', message.part.transcript, 'text', message.timestamp);
            }
            break;
          case 'response.output_item.done':
            // Handle complete item from OpenAI (includes final transcript)
            if (message.item && message.item.content && message.item.content[0] &&
                message.item.content[0].type === 'audio' && message.item.content[0].transcript) {
              console.log('🔄 Received complete agent transcript from response.output_item.done',
                message.item.content[0].transcript);
              // This could be used for verification or fallback
            }
            break;
          case 'agent_audio_chunk':
            // Handle incoming audio chunks from the AI agent
            if (message.audio) {
              handleIncomingAudioChunk(message.audio);
            }
            break;
          case 'agent_response_complete':
            // Play accumulated audio when response is complete
            playAccumulatedAudio();
            // Finalize any pending sentence
            finalizePendingSentences();
            break;
          case 'patient_transcript':
            if (message.transcript) {
              // Check if this forms an immediate sentence first
              if (!checkImmediateSentence('You', message.transcript, message.timestamp) && message.transcript.trim()) {
                processTranscriptDelta('You', message.transcript, message.timestamp);
              }
            }
            break;
          case 'red_flag_detected':
            const warningMessage = `⚠️ MEDICAL ALERT: ${message.severity?.toUpperCase()} SYMPTOMS DETECTED\n• ${message.symptoms?.join('\n• ')}\nClinical team has been notified.`;
            addToConversationLog('⚠️ ALERT', warningMessage, 'alert');
            break;
          case 'session_ended':
            // Finalize any pending sentences before ending session
            finalizePendingSentences();
            addToConversationLog('System', 'Session completed successfully', 'system');
            break;
          case 'request_session_end':
            // Finalize any pending sentences before ending session
            console.log('Received request_session_end from backend, ending session');
            endSession();
            break;
          case 'error':
            setErrorMessage(message.message || 'An error occurred');
            break;
        }
      };

      wsRef.current.onclose = () => {
        setConnectionStatus('Disconnected');
        if (sessionStatus === 'active') {
          setSessionStatus('completed');
        }
      };

      wsRef.current.onerror = () => {
        setConnectionStatus('Error');
        setSessionStatus('error');
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setErrorMessage('WebSocket connection failed');
      setSessionStatus('error');
    }
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (conversationMessagesRef.current) {
      conversationMessagesRef.current.scrollTop = conversationMessagesRef.current.scrollHeight;
    }
  }, [conversationLog]);

  const addToConversationLog = (speaker: string, message: string, type: 'text' | 'audio' | 'system' | 'alert' = 'text', timestamp?: string) => {
    const displayTimestamp = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    // If there's a pending sentence from the same speaker, combine them
    if (pendingSentence && pendingSentence.speaker === speaker && type === 'text') {
      // Create updated pending sentence with the same timeoutId
      const newPending = {
        speaker,
        text: pendingSentence.text + ' ' + message,
        timeoutId: pendingSentence.timeoutId,
        timestamp: pendingSentence.timestamp || timestamp
      };
      setPendingSentence(newPending);
      pendingSentenceRef.current = newPending;
      return;
    }

    // Otherwise add as new entry
    setConversationLog(prev => [...prev, {
      timestamp: displayTimestamp,
      speaker: speaker,
      message: message,
      type: type
    }]);
  };

  const addSentenceToConversationLog = (speaker: string, completeSentence: string, type: 'text' | 'audio' | 'system' | 'alert' = 'text', timestamp?: string) => {
    if (completeSentence.trim()) {
      const displayTimestamp = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
      setConversationLog(prev => [...prev, {
        timestamp: displayTimestamp,
        speaker: speaker,
        message: completeSentence.trim(),
        type: type
      }]);
      // Clear pending sentence after adding
      pendingSentenceRef.current = null;
      setPendingSentence(null);
    }
  };

  const processTranscriptDelta = (speaker: string, delta: string, timestamp?: string) => {
    if (delta.includes('[DONE]')) return;

    console.log(`🔄 Processing transcript delta for ${speaker}: "${delta}"`);

    // Clear any existing timeout for this speaker
    if (pendingSentenceRef.current && pendingSentenceRef.current.timeoutId) {
      console.log(`🧹 Clearing existing timeout for ${speaker}`);
      clearTimeout(pendingSentenceRef.current.timeoutId);
    }

    // Accumulate the delta in pending sentence
    let fullText = delta;
    let finalTimestamp = timestamp;
    if (pendingSentenceRef.current && pendingSentenceRef.current.speaker === speaker) {
      fullText = pendingSentenceRef.current.text + delta;
      finalTimestamp = pendingSentenceRef.current.timestamp; // Use the original timestamp
      console.log(`📝 Accumulating for ${speaker}: "${pendingSentenceRef.current.text}" + "${delta}" = "${fullText}"`);
    } else {
      console.log(`🆕 Starting new pending sentence for ${speaker}: "${fullText}"`);
      finalTimestamp = timestamp || (new Date()).toISOString();
    }

    // Check if we should finalize immediately
    if (checkImmediateSentence(speaker, fullText, finalTimestamp)) {
      // checkImmediateSentence will handle timing out and adding the sentence
      return;
    }

    // Start new timeout for finalization
    const timeoutId = setTimeout(() => finalizeSentence(speaker, fullText, finalTimestamp), 800);
    const pending = { speaker, text: fullText, timeoutId, timestamp: finalTimestamp };
    pendingSentenceRef.current = pending;
    setPendingSentence(pending);
  };

  const finalizeSentence = (speaker: string, text: string, timestamp?: string) => {
    console.log(`✅ Finalizing sentence for ${speaker}: "${text}"`);
    if (pendingSentence && pendingSentence.speaker === speaker) {
      // Clear the timeout
      console.log(`🧽 Clearing timeout for ${speaker}`);
      clearTimeout(pendingSentence.timeoutId);
      // Add the complete sentence to conversation log
      console.log(`📝 Adding sentence to conversation: ${speaker} - "${text.trim()}"`);
      addSentenceToConversationLog(speaker, text.trim(), 'text', timestamp || pendingSentence.timestamp);
      setPendingSentence(null);
      pendingSentenceRef.current = null;
    } else {
      console.log(`❌ No matching pending sentence for ${speaker} or wrong speaker:`, pendingSentence);
    }
  };

  const finalizePendingSentences = () => {
    if (pendingSentence) {
      // Clear any existing timeout
      clearTimeout(pendingSentence.timeoutId);
      addSentenceToConversationLog(pendingSentence.speaker, pendingSentence.text, 'text', pendingSentence.timestamp);
      setPendingSentence(null);
      pendingSentenceRef.current = null;
    }
  };

  const checkImmediateSentence = (speaker: string, text: string, timestamp?: string): boolean => {
    // For agent responses, be more conservative about immediate finalization
    if (speaker === 'Agent') {
      const trimmed = text.trim();

      // Handle punctuation-only deltas (like "?") by checking if we have a pending sentence
      if (/^[?!]$/.test(trimmed)) {
        if (pendingSentence && pendingSentence.speaker === 'Agent') {
          // Add the punctuation to the pending sentence and finalize it
          const completeSentence = pendingSentence.text + trimmed;
          clearTimeout(pendingSentence.timeoutId);
          addSentenceToConversationLog(speaker, completeSentence.trim(), 'text', timestamp || pendingSentence.timestamp);
          setPendingSentence(null);
          pendingSentenceRef.current = null;
          return true;
        } else {
          // No pending sentence, just add the punctuation as a message
          addSentenceToConversationLog(speaker, trimmed, 'text', timestamp);
          return true;
        }
      }

      // Don't immediately finalize agent sentences unless they end with punctuation
      if (/[.!?]\s*$/.test(trimmed) && trimmed.length > 1) {
        // Clear timeout and add sentence immediately
        if (pendingSentence && pendingSentence.timeoutId) {
          clearTimeout(pendingSentence.timeoutId);
        }
        addSentenceToConversationLog(speaker, text.trim(), 'text', timestamp || pendingSentence?.timestamp);
        setPendingSentence(null);
        pendingSentenceRef.current = null;
        return true;
      }

      return false; // Never immediately finalize agent sentences on periods or other punctuation
    }

    // For patient responses, keep original logic
    const trimmed = text.trim();

    // Check for period, question mark, or exclamation mark at the end
    if (/[.!?]\s*$/.test(trimmed)) {
      // Clear timeout and add sentence immediately
      if (pendingSentence && pendingSentence.timeoutId) {
        clearTimeout(pendingSentence.timeoutId);
      }
      addSentenceToConversationLog(speaker, text.trim());
      setPendingSentence(null);
      return true;
    }

    // Also consider it complete if it's a short response (like "Yes" or "No")
    if (trimmed.length <= 50 && /^[\w\s]+$/.test(trimmed) && !trimmed.includes(' ')) {
      if (pendingSentence && pendingSentence.timeoutId) {
        clearTimeout(pendingSentence.timeoutId);
      }
      addSentenceToConversationLog(speaker, text.trim());
      setPendingSentence(null);
      return true;
    }

    // Handle common short medical responses
    const shortResponses = ['yes', 'no', 'okay', 'fine', 'good', 'bad', 'pain', 'hurt'];
    if (shortResponses.some(response => trimmed.toLowerCase().includes(response)) && trimmed.length <= 30) {
      if (pendingSentence && pendingSentence.timeoutId) {
        clearTimeout(pendingSentence.timeoutId);
      }
      addSentenceToConversationLog(speaker, text.trim());
      setPendingSentence(null);
      return true;
    }

    return false;
  };

  const toggleRecording = () => {
    setIsRecording(!isRecording);
    isRecordingRef.current = !isRecording;
  };

  const endSession = async () => {
    console.log('endSession called');
    if (isRecording) {
      console.log('Stopping recording');
      setIsRecording(false);
      isRecordingRef.current = false;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    // Delay closing audio context to allow any ongoing audio playback to complete
    setTimeout(() => {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        try {
          audioContextRef.current.close();
          audioContextRef.current = null;
          gainNodeRef.current = null;
        } catch (error) {
          console.error('Error closing audio context:', error);
        }
      }
    }, 20000);
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'end_session' }));
    }
    setSessionStatus('completed');
    setIsRecording(false);
  };

  const handleIncomingAudioChunk = (audioChunk: string) => {
    // Accumulate audio chunks
    audioBufferRef.current += audioChunk;
    console.log(`Received audio chunk: ${audioChunk.length} characters`);
  };

  const playAccumulatedAudio = async () => {
    if (!audioBufferRef.current || isPlayingRef.current) {
      return;
    }

    try {
      isPlayingRef.current = true;
      console.log(`Playing accumulated audio: ${audioBufferRef.current.length} characters`);

      // Decode base64 audio data
      const audioData = atob(audioBufferRef.current);
      const audioBytes = new Uint8Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        audioBytes[i] = audioData.charCodeAt(i);
      }

      // Create audio context if not exists
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }

      const audioContext = audioContextRef.current;
      
      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Convert PCM16 bytes to AudioBuffer
      const audioBuffer = audioContext.createBuffer(1, audioBytes.length / 2, 24000);
      const channelData = audioBuffer.getChannelData(0);

      // Convert 16-bit PCM to float32 samples
      for (let i = 0; i < channelData.length; i++) {
        const byteIndex = i * 2;
        const sample = (audioBytes[byteIndex] | (audioBytes[byteIndex + 1] << 8));
        // Convert from signed 16-bit to float32 (-1 to 1)
        channelData[i] = sample < 32768 ? sample / 32768 : (sample - 65536) / 32768;
      }

      // Create and play audio source
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      
      // Connect to gain node if available, otherwise directly to destination
      if (gainNodeRef.current) {
        source.connect(gainNodeRef.current);
      } else {
        source.connect(audioContext.destination);
      }

      source.onended = () => {
        isPlayingRef.current = false;
        console.log('Audio playback completed');
      };

      source.start();
      
      // Clear the buffer after playing
      audioBufferRef.current = '';

    } catch (error) {
      console.error('Error playing audio:', error);
      isPlayingRef.current = false;
      // Clear buffer on error to prevent accumulation
      audioBufferRef.current = '';
    }
  };

  const resetSession = () => {
    setSessionStatus('idle');
    setSessionId(null);
    setConversationLog([]);
    setPendingSentence(null);
    pendingSentenceRef.current = null;
    setErrorMessage('');
    setSessionDuration(0);
    sessionStartTime.current = null;
    // Clear audio buffers
    audioBufferRef.current = '';
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
  };

  const handlePatientFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!patientName.trim()) {
      setErrorMessage('Please enter a patient name');
      return;
    }

    setShowPatientForm(false);
    setErrorMessage('');
    startSession(patientName.trim());
  };

  const handlePatientFormCancel = () => {
    setShowPatientForm(false);
    setPatientName('');
    setErrorMessage('');
  };

  return (
    <div className="session-page-container">
      {/* Page Header */}
      <div className="session-page-header">
        <div className="page-header-content">
          <div className="page-header-left">
            <h1 className="page-title">Voice Intake Session</h1>
            <p className="page-subtitle">Conduct AI-powered medical intake interviews with real-time voice processing</p>
          </div>
          <div className="page-header-right">
            <div className={`status-badge-large ${sessionStatus}`}>
              <div className="status-indicator">
                <div className="status-dot"></div>
                <span className="status-text">
                  {sessionStatus === 'idle' && 'Ready to Start'}
                  {sessionStatus === 'connecting' && 'Connecting...'}
                  {sessionStatus === 'active' && 'Session Active'}
                  {sessionStatus === 'completed' && 'Session Complete'}
                  {sessionStatus === 'error' && 'Error Occurred'}
                </span>
              </div>

              {sessionStatus === 'active' && (
                <div className="timer-display">
                  <span className="timer-icon">⏱️</span>
                  <span className="timer-value">{formatDuration(sessionDuration)}</span>
                </div>
              )}

              {sessionId && (
                <div className="session-id-display">
                  <span className="session-id-label">ID:</span>
                  <span className="session-id-value">{sessionId.slice(0, 8)}...</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="error-banner">
          <div className="error-banner-content">
            <div className="error-banner-icon">⚠️</div>
            <div className="error-banner-text">
              <h4>Session Error</h4>
              <p>{errorMessage}</p>
            </div>
            <button className="error-banner-close" onClick={() => setErrorMessage('')}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main Content Layout */}
      <div className="session-layout">
        {/* Main Conversation Area */}
        <div className="session-main-area">
          <div className="conversation-card">
            <div className="conversation-card-header">
              <div className="conversation-card-title">
                <h2>Live Conversation</h2>
              </div>
              <div className="conversation-indicators">
                {connectionStatus === 'Connected' && (
                  <div className="status-indicator-small connected">
                    <div className="connection-dot-small"></div>
                    <span>Connected</span>
                  </div>
                )}
                {isRecording && (
                  <div className="status-indicator-small recording">
                    <div className="recording-dot-small"></div>
                    <span>Recording</span>
                  </div>
                )}
              </div>
            </div>

            <div className="conversation-card-body">
              <div className="conversation-messages" ref={conversationMessagesRef}>
                {conversationLog.length === 0 && !pendingSentence ? (
                  <div className="empty-conversation">
                    <div className="empty-conversation-icon">🎙️</div>
                    <h3>Ready to Begin</h3>
                    <p>Start a new session to begin the AI-powered medical intake conversation</p>
                  </div>
                ) : (
                  <>
                    {conversationLog.map((entry, index) => (
                      <div key={index} className={`conversation-message ${entry.type} speaker-${entry.speaker.toLowerCase().replace(/[^a-z]/g, '')}`}>
                        <div className="message-avatar">
                          {entry.speaker === 'Agent' && '🤖'}
                          {entry.speaker === 'You' && '👤'}
                          {entry.speaker === 'System' && '⚙️'}
                          {entry.speaker === '⚠️ ALERT' && '🚨'}
                        </div>
                        <div className="message-bubble">
                          <div className="message-header">
                            <span className="message-speaker">{entry.speaker}</span>
                            <span className="message-time">{entry.timestamp}</span>
                          </div>
                          <div className="message-content">
                            {entry.message.split('\n').map((line, i) => (
                              <p key={i}>{line}</p>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}

                    {/* Show pending sentence with typing indicator */}
                    {pendingSentence && (
                      <div className={`conversation-message typing speaker-${pendingSentence.speaker.toLowerCase().replace(/[^a-z]/g, '')}`}>
                        <div className="message-avatar">
                          {pendingSentence.speaker === 'Agent' && '🤖'}
                          {pendingSentence.speaker === 'You' && '👤'}
                        </div>
                        <div className="message-bubble">
                          <div className="message-header">
                            <span className="message-speaker">{pendingSentence.speaker}</span>
                            <span className="message-time">{new Date().toLocaleTimeString()}</span>
                          </div>
                          <div className="message-content">
                            <p>{pendingSentence.text}<span className="typing-indicator">|</span></p>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Controls */}
        <div className="session-sidebar">
          {/* Session Controls */}
          <div className="control-panel">
            <h3 className="panel-title">Session Controls</h3>

            <div className="control-actions">
              {sessionStatus === 'idle' && (
                <div className="control-btn primary large" onClick={() => setShowPatientForm(true)}>
                  <span className="btn-icon">🎙️</span>
                  <span className="btn-content">
                    <span className="btn-text">Start New Session</span>
                    <span className="btn-subtitle">Begin voice intake</span>
                  </span>
                </div>
              )}

              {sessionStatus === 'active' && (
                <>
                  <div className="control-btn primary large" onClick={toggleRecording}>
                    <span className="btn-icon">{isRecording ? '⏸️' : '🎤'}</span>
                    <span className="btn-content">
                      <span className="btn-text">{isRecording ? 'Pause Recording' : 'Resume Recording'}</span>
                      <span className="btn-subtitle">{isRecording ? 'Stop voice input' : 'Continue conversation'}</span>
                    </span>
                  </div>

                  <div className="control-btn danger" onClick={endSession}>
                    <span className="btn-icon">⏹️</span>
                    <span className="btn-content">
                      <span className="btn-text">End Session</span>
                      <span className="btn-subtitle">Terminate conversation</span>
                    </span>
                  </div>
                </>
              )}

              {sessionStatus === 'completed' && (
                <>
                  <div className="control-btn success large" onClick={resetSession}>
                    <span className="btn-icon">🆕</span>
                    <span className="btn-content">
                      <span className="btn-text">Start New Session</span>
                      <span className="btn-subtitle">Begin another intake</span>
                    </span>
                  </div>

                  <div className="control-btn secondary" onClick={() => setShowTranscript(true)}>
                    <span className="btn-icon">📋</span>
                    <span className="btn-content">
                      <span className="btn-text">View Transcript</span>
                      <span className="btn-subtitle">See conversation history</span>
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>


          {/* Helpful Tips */}
          <div className="tips-panel">
            <h3 className="panel-title">Tips for Better Results</h3>
            <ul className="tips-list">
              <li className="tip-item">
                <span className="tip-icon">🎤</span>
                <span>Speak clearly and at a normal pace</span>
              </li>
              <li className="tip-item">
                <span className="tip-icon">🔇</span>
                <span>Minimize background noise</span>
              </li>
              <li className="tip-item">
                <span className="tip-icon">📝</span>
                <span>Provide detailed information</span>
              </li>
              <li className="tip-item">
                <span className="tip-icon">⏸️</span>
                <span>Pause between different topics</span>
              </li>
              <li className="tip-item">
                <span className="tip-icon">🚨</span>
                <span>Mention any urgent symptoms immediately</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Transcript Modal */}
      {showTranscript && (
        <div className="modal-overlay" onClick={() => setShowTranscript(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Session Transcript</h2>
              <button className="modal-close" onClick={() => setShowTranscript(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {conversationLog.length === 0 ? (
                <p className="modal-empty">No conversation recorded yet.</p>
              ) : (
                <div className="modal-messages">
                  {conversationLog.map((entry, index) => (
                    <div key={index} className={`modal-message ${entry.type}`}>
                      <div className="modal-message-meta">
                        <span className="modal-speaker">{entry.speaker}</span>
                        <span className="modal-time">{entry.timestamp}</span>
                      </div>
                      <div className="modal-message-content">
                        {entry.message.split('\n').map((line, i) => (
                          <p key={i}>{line}</p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowTranscript(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={() => {
                const transcript = conversationLog.map(entry =>
                  `[${entry.timestamp}] ${entry.speaker}: ${entry.message}`
                ).join('\n\n');
                navigator.clipboard.writeText(transcript);
                alert('Transcript copied to clipboard!');
              }}>
                Copy Transcript
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Patient Name Form Modal */}
      {showPatientForm && (
        <div className="modal-overlay" onClick={handlePatientFormCancel}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Enter Patient Information</h2>
              <button className="modal-close" onClick={handlePatientFormCancel}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <form onSubmit={handlePatientFormSubmit}>
                <div className="form-group">
                  <label htmlFor="patientName" className="form-label">
                    Patient Name <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    id="patientName"
                    className="form-input"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="Enter patient's full name"
                    autoFocus
                    required
                  />
                </div>
              </form>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handlePatientFormCancel}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                onClick={handlePatientFormSubmit}
                disabled={!patientName.trim()}
              >
                Start Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Session;