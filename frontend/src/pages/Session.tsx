import React, { useState, useEffect, useRef } from 'react';
import { RetellWebClient } from 'retell-client-js-sdk';

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
  const [pendingSentence, setPendingSentence] = useState<{ speaker: string, text: string, timeoutId: number, timestamp?: string } | null>(null);
  const [speaker, setSpeaker] = useState<string>(''); // Current speaker indicator
  const [provider, setProvider] = useState<string>('openai'); // AI provider type

  // New state for patient name input
  const [patientName, setPatientName] = useState<string>('');
  const [showPatientForm, setShowPatientForm] = useState<boolean>(false);
  const pendingSentenceRef = useRef<{ speaker: string, text: string, timeoutId: number, timestamp?: string } | null>(null);

  const conversationMessagesRef = useRef<HTMLDivElement>(null);
  const token = localStorage.getItem("jwt_token");

  const wsRef = useRef<WebSocket | null>(null);
  const retellWebClientRef = useRef<RetellWebClient | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const gainNodeRef = useRef<GainNode | null>(null);
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

      const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: {
          "Authorization": `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ patientName: patientNameToUse }),
      });

      const data = await response.json();

      if (data.sessionId) {
        setSessionId(data.sessionId);
        setProvider(data.provider || 'openai');
        setSessionStatus('active');
        setConversationLog([{
          timestamp: new Date().toLocaleTimeString(),
          speaker: 'System',
          message: 'Welcome to the Medical Intake Voice Agent. Please speak clearly and provide detailed information about your medical concerns.',
          type: 'system'
        }]);

        if (data.provider === 'retellai') {
          // For Retell AI, start web call directly
          await startRetellWebCall(data.sessionId);
        } else {
          // For OpenAI, initialize audio and connect WebSocket
          await initializeAudioRecording();
          connectWebSocket(data.sessionId);
        }
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
      wsRef.current = new WebSocket('/ws');
      console.log('WebSocket readyState:', wsRef.current.readyState);

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
              setSpeaker('Patient');
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
              setSpeaker('');
              // Add complete transcript directly
              addSentenceToConversationLog('Agent', message.transcript, 'text', message.timestamp);
            }
            break;
          case 'conversation.item.input_audio_transcription.delta':
            if (message.delta) {
              setSpeaker('');
              // Handle patient transcript deltas
              if (!checkImmediateSentence('You', message.delta) && message.delta.trim()) {
                processTranscriptDelta('You', message.delta);
              }
            }
            break;
          case 'response.content_part.done':
            setSpeaker('');
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
            setSpeaker('');
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
          case "listening":
            setSpeaker('Patient');
            break;
          case "speaking":
            setSpeaker('Agent');
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
        console.error('Failed to connect WebSocket on error method');
        setConnectionStatus('Error');
        setSessionStatus('error');
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setErrorMessage('WebSocket connection failed');
      setSessionStatus('error');
    }
  };

  const startRetellWebCall = async (sessionId: string) => {
    try {
      setConnectionStatus('Connecting to Retell AI...');

      // Get access token from backend
      const response = await fetch(`/api/sessions/${sessionId}/start-web-call`, {
        method: 'POST',
        headers: {
          "Authorization": `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!data.access_token) {
        throw new Error(data.message || 'Failed to get access token');
      }

      // Initialize Retell Web Client
      retellWebClientRef.current = new RetellWebClient();
      const retellWebClient = retellWebClientRef.current;

      // Set up event listeners - log ALL events for debugging
      const allEvents = [
        'call_started', 'call_ended', 'realtime_transcript',
        'agent_start_talking', 'agent_stop_talking', 'error',
        'audio', 'transcript', 'tool_call', 'function_call'
      ];

      allEvents.forEach(eventName => {
        retellWebClient.on(eventName, (event: any) => {
          console.log(`🔄 Retell AI event [${eventName}]:`, event);
        });
      });

      retellWebClient.on('call_started', () => {
        console.log('Retell AI call started');
        setConnectionStatus('Connected');
        addToConversationLog('System', 'Connected to Retell AI. Call is active.', 'system');
      });

      retellWebClient.on('call_ended', async () => {
        console.log('Retell AI call ended');
        setConnectionStatus('Disconnected');
        setSessionStatus('completed');
        addToConversationLog('System', 'Call ended successfully', 'system');

        // Automatically fetch the complete transcript after call ends
        if (sessionId) {
          try {
            console.log('Fetching complete transcript from Retell AI...');
            const response = await fetch(`/api/sessions/${sessionId}/retell-transcript`, {
              method: 'GET',
              headers: {
                "Authorization": `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });

            const transcriptData = await response.json();

            if (response.ok && transcriptData.transcript) {
              console.log('Successfully retrieved complete transcript:', transcriptData);
              addToConversationLog('System', `Complete transcript retrieved: ${transcriptData.summary.total_items} items (${transcriptData.summary.agent_lines} agent, ${transcriptData.summary.user_lines} user)`, 'system');
            } else {
              console.error('Failed to retrieve transcript:', transcriptData);
              addToConversationLog('System', 'Failed to retrieve complete transcript', 'system');
            }
          } catch (error) {
            console.error('Error fetching transcript:', error);
            addToConversationLog('System', 'Error retrieving complete transcript', 'system');
          }
        }
      });

      // ✅ CORRECT EVENT 1: Real-time Transcript (User only, streaming)
      retellWebClient.on('realtime_transcript', (event: any) => {
        console.log('Retell AI REALTIME transcript:', event);
        // { transcript: "...", is_final: false, turn: "user" }

        if (event.transcript && event.turn === 'user') {
          // Update live typing indicator (optional)
          // processRealtimeTranscript(event.transcript);
        }
      });

      // ✅ CORRECT EVENT 2: Final Transcript (User AND Agent)
      retellWebClient.on('transcript', async (event: any) => {
        console.log('Retell AI FINAL transcript:', event);
        // { transcript: "...", turn: "user" | "agent" }

        if (event.transcript) {
          const speaker = event.turn === 'user' ? 'patient' : 'agent';

          try {
            // Save transcript to backend for persistence
            await fetch(`/api/sessions/${sessionId}/transcript`, {
              method: 'POST',
              headers: {
                "Authorization": `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                speaker: speaker,
                message: event.transcript,
                timestamp: new Date().toISOString(),
                type: event.turn === 'user' ? 'user_transcript' : 'agent_transcript'
              })
            });

            // Update UI
            const uiSpeaker = event.turn === 'user' ? 'You' : 'Agent';
            if (!checkImmediateSentence(uiSpeaker, event.transcript) && event.transcript.trim()) {
              processTranscriptDelta(uiSpeaker, event.transcript);
            }
          } catch (error) {
            console.error('Failed to save transcript:', error);
          }
        }
      });

      retellWebClient.on('agent_start_talking', () => {
        setSpeaker('Agent');
      });

      retellWebClient.on('agent_stop_talking', () => {
        setSpeaker('Patient');
      });

      retellWebClient.on('error', (error: any) => {
        console.error('Retell AI error:', error);
        setErrorMessage(error.message || 'Retell AI error occurred');
        setSessionStatus('error');
      });

      // Start the call
      await retellWebClient.startCall({
        accessToken: data.access_token,
      });

    } catch (error: any) {
      console.error('Failed to start Retell AI web call:', error);
      setErrorMessage(error.message || 'Failed to connect to Retell AI');
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

    // Handle provider-specific cleanup
    if (provider === 'retellai') {
      // End Retell AI call
      if (retellWebClientRef.current) {
        try {
          await retellWebClientRef.current.stopCall();
          console.log('Retell AI call stopped');
        } catch (error) {
          console.error('Error stopping Retell AI call:', error);
        }
      }
    } else {
      // Handle OpenAI/WebSocket cleanup
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
    setProvider('openai'); // Reset to default provider
    // Clear audio buffers
    audioBufferRef.current = '';
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
    // Clean up Retell Web Client if exists
    if (retellWebClientRef.current) {
      retellWebClientRef.current = null;
    }
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
    <div className="session-page-container w-100">
      {/* Page Header */}
      <div className="session-page-header w-100">
        <div className="container-fluid px-3 px-md-4">
          <div className="row align-items-start g-3 py-3">
            <div className="col-12 col-lg-8">
              <h1 className="h2 fw-bold text-primary mb-2">Voice Intake Session</h1>
              <p className="text-muted mb-0">Conduct AI-powered medical intake interviews with real-time voice processing</p>
            </div>
            {sessionStatus !== 'idle' && (
              <>
                <div className="col-12 col-lg-4">
                  <div className={`d-flex flex-column flex-sm-row align-items-start align-sm-center gap-2 gap-sm-3 p-3 rounded-3 border ${sessionStatus === 'connecting' ? 'bg-warning-subtle border-warning' :
                      sessionStatus === 'active' ? 'bg-success-subtle border-success' :
                        sessionStatus === 'completed' ? 'bg-primary-subtle border-primary' :
                          'bg-danger-subtle border-danger'
                    }`}>
                    <div className="d-flex align-items-center gap-2 flex-shrink-0">
                      <div className={`rounded-circle status-dot ${sessionStatus === 'active' ? 'bg-success' :
                          sessionStatus === 'error' ? 'bg-danger' :
                            sessionStatus === 'connecting' ? 'bg-warning' :
                              'bg-secondary'
                        }`}></div>
                      <span className="fw-semibold small">
                        {sessionStatus === 'connecting' && 'Connecting...'}
                        {sessionStatus === 'active' && 'Session Active'}
                        {sessionStatus === 'completed' && 'Session Complete'}
                        {sessionStatus === 'error' && 'Error Occurred'}
                      </span>
                    </div>

                    <div className="d-flex gap-2 flex-wrap">
                      {sessionStatus === 'active' && (
                        <div className="d-flex align-items-center gap-2 px-2 py-1 bg-white rounded flex-shrink-0">
                          <i className="fas fa-clock text-muted"></i>
                          <span className="font-monospace fw-semibold small">{formatDuration(sessionDuration)}</span>
                        </div>
                      )}

                      {sessionId && (
                        <div className="d-flex align-items-center gap-2 px-2 py-1 bg-white rounded flex-shrink-0">
                          <span className="text-muted small">ID:</span>
                          <span className="font-monospace fw-semibold small">{sessionId.slice(0, 8)}...</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

          </div>
        </div>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="container-fluid px-3 px-md-4">
          <div className="alert alert-danger alert-dismissible mb-3" role="alert">
            <div className="d-flex align-items-start">
              <i className="fas fa-exclamation-triangle me-3 mt-1 flex-shrink-0"></i>
              <div className="flex-grow-1">
                <h6 className="alert-heading mb-1">Session Error</h6>
                <p className="mb-0">{errorMessage}</p>
              </div>
            </div>
            <button type="button" className="btn-close" onClick={() => setErrorMessage('')}></button>
          </div>
        </div>
      )}

      {/* Main Content Layout */}
      <div className="container-fluid px-3 px-md-4 pb-4">
        <div className="row g-3 g-md-4">
          {/* Main Conversation Area */}
          <div className="col-12 col-xl-8">
            <div className="card h-100 border-0 shadow-sm">
              <div className="card-header bg-white border-bottom">
                <div className="d-flex justify-content-between align-items-center">
                  <div className="d-flex align-items-center gap-3">
                    <h5 className="card-title mb-0">Live Conversation</h5>
                    {speaker && (
                      <span className="badge bg-info-subtle text-info border border-info-subtle fw-semibold px-3 py-2">
                        <i className={`fas me-2 ${speaker === 'Agent' ? 'fa-volume-up' : 'fa-microphone'}`} style={{ fontSize: '0.875rem' }}></i>
                        <span className="fs-6">
                          {speaker === 'Agent' ? 'Doctor' : 'Patient'}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="d-flex gap-2">
                    {connectionStatus === 'Connected' && (
                      <span className="badge bg-success-subtle text-success border border-success-subtle">
                        <i className="fas fa-circle me-1 status-icon-small"></i>
                        Connected
                      </span>
                    )}
                    {connectionStatus === 'Connecting to Retell AI...' && (
                      <span className="badge bg-warning-subtle text-warning border border-warning-subtle">
                        <i className="fas fa-spinner fa-spin me-1" style={{ fontSize: '0.5rem' }}></i>
                        Connecting to Retell AI
                      </span>
                    )}
                    {provider !== 'retellai' && isRecording && (
                      <span className="badge bg-danger-subtle text-danger border border-danger-subtle">
                        <i className="fas fa-circle me-1" style={{ fontSize: '0.5rem', animation: 'pulse 1.5s infinite' }}></i>
                        Recording
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="card-body p-0 conversation-card-body">
                <div className="conversation-messages h-100 overflow-auto p-4" ref={conversationMessagesRef}>
                  {conversationLog.length === 0 && !pendingSentence ? (
                    <div className="d-flex flex-column align-items-center justify-content-center h-100 text-center conversation-card-body-cursor"
                      onClick={() => setShowPatientForm(true)}>
                      <i className="fas fa-microphone fa-4x text-muted mb-4" style={{ opacity: '0.5' }}></i>
                      <h4 className="text-primary mb-2">Ready to Begin</h4>
                      <p className="text-muted">Start a new session to begin the AI-powered medical intake conversation</p>
                    </div>
                  ) : (
                    <>
                      {conversationLog.map((entry, index) => (
                        <div key={index} className={`conversation-message d-flex gap-3 mb-4 speaker-${entry.speaker.toLowerCase().replace(/[^a-z]/g, '')}`}>
                          <div className={`message-avatar rounded-circle d-flex align-items-center justify-content-center flex-shrink-0 ${entry.speaker === 'Agent' ? 'bg-primary-subtle text-primary' :
                              entry.speaker === 'You' ? 'bg-success-subtle text-success' :
                                entry.speaker === 'System' ? 'bg-warning-subtle text-warning' :
                                  'bg-danger-subtle text-danger'
                            } message-avatar"`}>
                            {entry.speaker === 'Agent' && <i className="fas fa-user-md"></i>}
                            {entry.speaker === 'You' && <i className="fas fa-user"></i>}
                            {entry.speaker === 'System' && <i className="fas fa-cog"></i>}
                            {entry.speaker === '⚠️ ALERT' && <i className="fas fa-exclamation-triangle"></i>}
                          </div>
                          <div className={`message-bubble flex-grow-1 p-3 rounded-3 ${entry.speaker === 'Agent' ? 'bg-primary-subtle border border-primary-subtle' :
                              entry.speaker === 'You' ? 'bg-success-subtle border border-success-subtle' :
                                entry.speaker === 'System' ? 'bg-warning-subtle border border-warning-subtle' :
                                  'bg-danger-subtle border border-danger-subtle'
                            }`} style={{ maxWidth: '80%' }}>
                            <div className="d-flex justify-content-between align-items-center mb-2">
                              <span className="fw-semibold small">{entry.speaker}</span>
                              <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>{entry.timestamp}</span>
                            </div>
                            <div className="message-content">
                              {entry.message.split('\n').map((line, i) => (
                                <p key={i} className="mb-1 last:mb-0">{line}</p>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}

                      {/* Show pending sentence with typing indicator */}
                      {pendingSentence && (
                        <div className={`conversation-message d-flex gap-3 mb-4 speaker-${pendingSentence.speaker.toLowerCase().replace(/[^a-z]/g, '')}`}>
                          <div className={`message-avatar rounded-circle d-flex align-items-center justify-content-center flex-shrink-0 ${pendingSentence.speaker === 'Agent' ? 'bg-primary-subtle text-primary' : 'bg-success-subtle text-success'
                            } message-avatar"`}>
                            {pendingSentence.speaker === 'Agent' ? <i className="fas fa-user-md"></i> : <i className="fas fa-user"></i>}
                          </div>
                          <div className={`message-bubble flex-grow-1 p-3 rounded-3 ${pendingSentence.speaker === 'Agent' ? 'bg-primary-subtle border border-primary-subtle' : 'bg-success-subtle border border-success-subtle'
                            }`} style={{ maxWidth: '80%', opacity: '0.8' }}>
                            <div className="d-flex justify-content-between align-items-center mb-2">
                              <span className="fw-semibold small">
                                {pendingSentence.speaker === 'Agent' ? 'Doctor' : 'Patient'}
                              </span>
                              <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>{new Date().toLocaleTimeString()}</span>
                            </div>
                            <div className="message-content">
                              <p className="mb-0">{pendingSentence.text}<span className="typing-indicator text-primary fw-bold">|</span></p>
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
          <div className="col-12 col-xl-4">
            <div className="row g-3 g-md-4">
              {/* Session Controls */}
              {sessionStatus && sessionStatus !== 'idle' && (
                <>
                <div className="col-12">
                  <div className="card border-0 shadow-sm h-100">

                    <div className="card-header bg-white border-bottom">
                      <h5 className="card-title mb-0">Session Controls</h5>
                    </div>
                    <div className="card-body">
                      <div className="d-grid gap-3">
                        {sessionStatus === 'active' && (
                          <>
                            {provider === 'retellai' ? (
                              // Retell AI controls - simpler, just end call
                              <button className="btn btn-danger btn-lg d-flex align-items-center gap-3 p-3 w-100" onClick={endSession}>
                                <i className="fas fa-phone-slash fa-2x flex-shrink-0"></i>
                                <div className="text-start flex-grow-1">
                                  <div className="fw-bold">End Call</div>
                                  <small className="opacity-75">Terminate voice call</small>
                                </div>
                              </button>
                            ) : (
                              // OpenAI controls - recording controls
                              <>
                                <button className={`btn ${isRecording ? 'btn-warning' : 'btn-primary'} btn-lg d-flex align-items-center gap-3 p-3 w-100`} onClick={toggleRecording}>
                                  <i className={`fas ${isRecording ? 'fa-pause' : 'fa-microphone'} fa-2x flex-shrink-0`}></i>
                                  <div className="text-start flex-grow-1">
                                    <div className="fw-bold">{isRecording ? 'Pause Recording' : 'Resume Recording'}</div>
                                    <small className="opacity-75">{isRecording ? 'Stop voice input' : 'Continue conversation'}</small>
                                  </div>
                                </button>

                                <button className="btn btn-danger d-flex align-items-center gap-3 p-3 w-100" onClick={endSession}>
                                  <i className="fas fa-stop fa-lg flex-shrink-0"></i>
                                  <div className="text-start flex-grow-1">
                                    <div className="fw-bold">End Session</div>
                                    <small className="opacity-75">Terminate conversation</small>
                                  </div>
                                </button>
                              </>
                            )}
                          </>
                        )}

                        {sessionStatus === 'completed' && (
                          <>
                            <button className="btn btn-success btn-lg d-flex align-items-center gap-3 p-3 w-100" onClick={resetSession}>
                              <i className="fas fa-plus fa-2x flex-shrink-0"></i>
                              <div className="text-start flex-grow-1">
                                <div className="fw-bold">Start New Session</div>
                                <small className="opacity-75">Begin another intake</small>
                              </div>
                            </button>

                            <button className="btn btn-outline-secondary d-flex align-items-center gap-3 p-3 w-100" onClick={() => setShowTranscript(true)}>
                              <i className="fas fa-file-alt fa-lg flex-shrink-0"></i>
                              <div className="text-start flex-grow-1">
                                <div className="fw-bold">View Transcript</div>
                                <small className="opacity-75">See conversation history</small>
                              </div>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

              {/* Helpful Tips */}
              <div className="col-12">
                <div className="card border-0 shadow-sm h-100">
                  <div className="card-header bg-white border-bottom">
                    <h5 className="card-title mb-0">Tips for Better Results</h5>
                  </div>
                  <div className="card-body">
                    <div className="d-flex flex-column gap-2 gap-md-3">
                      <div className="d-flex align-items-start gap-2 gap-md-3 p-2 bg-light rounded">
                        <i className="fas fa-microphone text-primary mt-1 flex-shrink-0"></i>
                        <span className="small">Speak clearly and at a normal pace</span>
                      </div>
                      <div className="d-flex align-items-start gap-2 gap-md-3 p-2 bg-light rounded">
                        <i className="fas fa-volume-mute text-primary mt-1 flex-shrink-0"></i>
                        <span className="small">Minimize background noise</span>
                      </div>
                      <div className="d-flex align-items-start gap-2 gap-md-3 p-2 bg-light rounded">
                        <i className="fas fa-edit text-primary mt-1 flex-shrink-0"></i>
                        <span className="small">Provide detailed information</span>
                      </div>
                      <div className="d-flex align-items-start gap-2 gap-md-3 p-2 bg-light rounded">
                        <i className="fas fa-pause text-primary mt-1 flex-shrink-0"></i>
                        <span className="small">Pause between different topics</span>
                      </div>
                      <div className="d-flex align-items-start gap-2 gap-md-3 p-2 bg-light rounded">
                        <i className="fas fa-exclamation-triangle text-danger mt-1 flex-shrink-0"></i>
                        <span className="small">Mention any urgent symptoms immediately</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Transcript Modal */}
      {showTranscript && (
        <div className="modal fade show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => setShowTranscript(false)}>
          <div className="modal-dialog modal-lg modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content border-0 shadow">
              <div className="modal-header bg-light">
                <h5 className="modal-title fw-semibold">Session Transcript</h5>
                <button type="button" className="btn-close" onClick={() => setShowTranscript(false)}></button>
              </div>
              <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                {conversationLog.length === 0 ? (
                  <div className="text-center text-muted py-5">
                    <i className="fas fa-file-alt fa-3x mb-3 opacity-50"></i>
                    <p className="mb-0">No conversation recorded yet.</p>
                  </div>
                ) : (
                  <div className="d-flex flex-column gap-3">
                    {conversationLog.map((entry, index) => (
                      <div key={index} className={`p-3 rounded border-start border-4 ${entry.type === 'system' ? 'bg-warning-subtle border-warning' :
                          entry.type === 'alert' ? 'bg-danger-subtle border-danger' :
                            'bg-light border-primary'
                        }`}>
                        <div className="d-flex justify-content-between align-items-center mb-2">
                          <span className="fw-semibold small text-primary">{entry.speaker}</span>
                          <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>{entry.timestamp}</span>
                        </div>
                        <div className="message-content">
                          {entry.message.split('\n').map((line, i) => (
                            <p key={i} className="mb-1 last:mb-0">{line}</p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="modal-footer bg-light">
                <button type="button" className="btn btn-secondary" onClick={() => setShowTranscript(false)}>
                  Close
                </button>
                <button type="button" className="btn btn-primary d-flex align-items-center gap-2" onClick={() => {
                  const transcript = conversationLog.map(entry =>
                    `[${entry.timestamp}] ${entry.speaker}: ${entry.message}`
                  ).join('\n\n');
                  navigator.clipboard.writeText(transcript);
                  alert('Transcript copied to clipboard!');
                }}>
                  <i className="fas fa-copy"></i>
                  Copy Transcript
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Patient Name Form Modal */}
      {showPatientForm && (
        <div className="modal fade show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={handlePatientFormCancel}>
          <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content border-0 shadow">
              <div className="modal-header bg-light">
                <h5 className="modal-title fw-semibold">Enter Patient Information</h5>
                <button type="button" className="btn-close" onClick={handlePatientFormCancel}></button>
              </div>
              <div className="modal-body">
                <form onSubmit={handlePatientFormSubmit}>
                  <div className="mb-3">
                    <label htmlFor="patientName" className="form-label fw-semibold">
                      Patient Name <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      id="patientName"
                      className="form-control form-control-lg"
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      placeholder="Enter patient's full name"
                      autoFocus
                      required
                    />
                    <div className="form-text">
                      <i className="fas fa-info-circle me-1"></i>
                      This information will be used to identify the session
                    </div>
                  </div>
                </form>
              </div>
              <div className="modal-footer bg-light">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handlePatientFormCancel}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary d-flex align-items-center gap-2"
                  onClick={handlePatientFormSubmit}
                  disabled={!patientName.trim()}
                >
                  <i className="fas fa-play"></i>
                  Start Session
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Session;