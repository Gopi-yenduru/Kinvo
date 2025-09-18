import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

interface TranscriptEntry {
  timestamp: string;
  speaker: string;
  message: string;
}

interface TranscriptData {
  transcript: TranscriptEntry[];
  duration: number;
  redFlagEvents: any[];
  summary: {
    totalLines: number;
    agentLines: number;
    patientLines: number;
    systemMessages: number;
    redFlagsDetected: number;
  };
}

const Transcript: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [transcriptData, setTranscriptData] = useState<TranscriptData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTranscriptData = async () => {
      try {
        // First try to get data from navigation state (for backward compatibility)
        const stateData = location.state?.transcriptData;
        if (stateData) {
          setTranscriptData(stateData);
          setLoading(false);
          return;
        }

        // If no state data, try to get sessionId from URL and fetch from API
        if (sessionId) {
          const response = await fetch(`/api/sessions/${sessionId}/transcript`);
          const data = await response.json();

          if (data.transcript) {
            setTranscriptData(data);
          } else {
            console.error('No transcript data found');
            navigate('/sessions');
          }
        } else {
          // No sessionId in URL and no data in state
          navigate('/sessions');
        }
      } catch (error) {
        console.error('Failed to fetch transcript data:', error);
        navigate('/sessions');
      } finally {
        setLoading(false);
      }
    };

    fetchTranscriptData();
  }, [location.state, navigate, sessionId]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getSpeakerIcon = (speaker: string) => {
    switch (speaker) {
      case 'agent':
        return '🤖';
      case 'patient':
        return '👤';
      case 'system':
        return '⚙️';
      default:
        return '💬';
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Loading transcript...</p>
      </div>
    );
  }

  if (!transcriptData) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Transcript not found...</p>
      </div>
    );
  }

  return (
    <div className="transcript-page">
      <div className="transcript-header">
        <div className="page-title">
          <h1>Session Transcript</h1>
          <p>Full conversation transcript for the intake session</p>
        </div>
        <div className="transcript-actions">
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/sessions')}
          >
            <span className="btn-icon">⬅️</span>
            Back to Sessions
          </button>
        </div>
      </div>

      <div className="transcript-summary">
        <div className="summary-grid">
          <div className="summary-item">
            <div className="summary-number">{transcriptData.summary.totalLines}</div>
            <div className="summary-label">Total Messages</div>
          </div>
          <div className="summary-item">
            <div className="summary-number">{transcriptData.summary.agentLines}</div>
            <div className="summary-label">Agent Responses</div>
          </div>
          <div className="summary-item">
            <div className="summary-number">{transcriptData.summary.patientLines}</div>
            <div className="summary-label">Patient Messages</div>
          </div>
          <div className="summary-item">
            <div className="summary-number">{transcriptData.summary.redFlagsDetected}</div>
            <div className="summary-label">Red Flags Detected</div>
          </div>
        </div>
      </div>

      <div className="transcript-content">
        <div className="transcript-messages">
          {transcriptData.transcript.map((entry, index) => (
            <div key={index} className={`transcript-entry ${entry.speaker}`}>
              <div className="transcript-meta">
                <div className="transcript-speaker">
                  <span className="speaker-icon">{getSpeakerIcon(entry.speaker)}</span>
                  <span className="speaker-name">{entry.speaker.charAt(0).toUpperCase() + entry.speaker.slice(1)}</span>
                </div>
                <div className="transcript-time">
                  {formatTimestamp(entry.timestamp)}
                </div>
              </div>
              <div className="transcript-message">
                {entry.message}
              </div>
            </div>
          ))}
        </div>

        {transcriptData.transcript.length === 0 && (
          <div className="empty-transcript">
            <div className="empty-icon">📝</div>
            <h3>No Transcript Available</h3>
            <p>The transcript for this session could not be loaded or is empty.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Transcript;