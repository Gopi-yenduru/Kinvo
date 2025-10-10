import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Session {
  id: string;
  start_time: string;
  end_time?: string;
  status: string;
  red_flags_detected: number;
  patient_name?: string;
  estimated_cost?: number;
}

const Sessions: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [generatingReport, setGeneratingReport] = useState<string | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportContent, setReportContent] = useState<string>('');
  const [reportSessionId, setReportSessionId] = useState<string>('');
  
  const navigate = useNavigate();

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/sessions');
      const data = await response.json();
      
      if (data.sessions) {
        const sortedSessions = data.sessions.sort((a: Session, b: Session) =>
          new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
        );
        setSessions(sortedSessions);
      } else {
        setError('Failed to load sessions');
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      setError('Unable to load sessions');
    } finally {
      setLoading(false);
    }
  };

  const viewTranscript = async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/transcript`);
      const data = await response.json();

      if (data.transcript) {
        navigate(`/sessions/${sessionId}/transcript`, { state: { transcriptData: data } });
      } else {
        setError('Failed to load transcript');
      }
    } catch (err) {
      console.error('Failed to fetch transcript:', err);
      setError('Unable to load transcript');
    }
  };

  const generateReport = async (sessionId: string) => {
    try {
      setGeneratingReport(sessionId);
      const response = await fetch(`/api/sessions/${sessionId}/generate-report`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.report) {
        setReportContent(data.report);
        setReportSessionId(sessionId);
        setShowReportModal(true);
      } else {
        setError('Failed to generate report');
      }
    } catch (err) {
      console.error('Failed to generate report:', err);
      setError('Unable to generate report');
    } finally {
      setGeneratingReport(null);
    }
  };

  const downloadReport = (sessionId: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${sessionId}-report.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const closeReportModal = () => {
    setShowReportModal(false);
    setReportContent('');
    setReportSessionId('');
  };

  const filteredSessions = sessions;

  const getSessionDuration = (session: Session) => {
    if (!session.end_time) return 'Ongoing';
    const duration = new Date(session.end_time).getTime() - new Date(session.start_time).getTime();
    const minutes = Math.round(duration / 1000 / 60);
    return `${minutes} min`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'success';
      case 'active': return 'warning';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  };

  if (loading) {
    return (
      <div className="sessions-loading">
        <div className="loading-spinner"></div>
        <p>Loading sessions...</p>
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <div className="sessions-header">
        <div className="page-title">
          <h1>Medical Intake Sessions</h1>
          <p>View and manage all patient intake sessions</p>
        </div>
      </div>

      {error && (
        <div className="error-alert">
          <div className="error-icon">⚠️</div>
          <div className="error-content">
            <h3>Error</h3>
            <p>{error}</p>
            <button className="error-dismiss" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="row g-3 g-md-4 mb-4">
          <div className="col-12 col-sm-6 col-lg-4">
            <div className="stat-card primary h-100">
              <div className="stat-icon">
                <i className="fas fa-clipboard-list"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{sessions.length}</div>
                <div className="stat-label">Total Sessions</div>
                
              </div>
            </div>
          </div>

          <div className="col-12 col-sm-6 col-lg-4">
            <div className="stat-card success h-100">
              <div className="stat-icon">
                <i className="fas fa-check-circle"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{sessions.filter(s => s.red_flags_detected > 0).length}</div>
                <div className="stat-label">With Red Flags</div>
                
              </div>
            </div>
          </div>

          <div className="col-12 col-sm-12 col-lg-4">
            <div className="stat-card warning h-100">
              <div className="stat-icon">
                <i className="fas fa-exclamation-triangle"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{sessions.filter(s => s.status === 'completed').length}</div>
                <div className="stat-label">Completed</div>
                
              </div>
            </div>
          </div>
        </div>

      <div className="sessions-content">
        {filteredSessions.length === 0 ? (
          <div className="empty-sessions">
            <div className="empty-icon">📋</div>
            <h3>No Sessions Found</h3>
            <p>
              {sessions.length === 0
                ? 'No intake sessions have been created yet'
                : 'No sessions found'}
            </p>
            {sessions.length === 0 && (
              <button className="btn btn-primary" onClick={() => navigate('/session')}>
                <span className="btn-icon">🎙️</span>
                Start First Session
              </button>
            )}
          </div>
        ) : (
          <div className="sessions-table-container">
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Patient Name</th>
                  <th>Status</th>
                  <th>Start Time</th>
                  <th>Duration</th>
                  <th>Cost</th>
                  <th>Red Flags</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSessions.map((session) => (
                  <tr key={session.id}>
                    <td>#{session.id.slice(0, 8)}</td>
                    <td>
                      {session.patient_name || <span className="no-flags">—</span>}
                    </td>
                    <td>
                      <span className={`status-badge ${getStatusColor(session.status)}`}>
                        {session.status}
                      </span>
                    </td>
                    <td>
                      {new Date(session.start_time).toLocaleDateString()} at{' '}
                      {new Date(session.start_time).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                    <td>{getSessionDuration(session)}</td>
                    <td>
                      {session.estimated_cost != null ? (
                        <span className="cost-text">${session.estimated_cost.toFixed(4)}</span>
                      ) : (
                        <span className="no-flags">—</span>
                      )}
                    </td>
                    <td>
                      {session.red_flags_detected > 0 ? (
                        <span className="red-flag-text">⚠️ {session.red_flags_detected}</span>
                      ) : (
                        <span className="no-flags">—</span>
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="action-btn-sm primary"
                          onClick={() => viewTranscript(session.id)}
                        >
                          <span className="btn-icon-sm">📄</span>
                          Transcript
                        </button>
                        <button
                          className="action-btn-sm secondary"
                          onClick={() => generateReport(session.id)}
                          disabled={generatingReport === session.id}
                        >
                          <span className="btn-icon-sm">📄</span>
                          {generatingReport === session.id ? 'Generating...' : 'Generate Report'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Report Modal */}
      {showReportModal && (
        <div className="modal-overlay" onClick={closeReportModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Medical Intake Report</h2>
              <button className="modal-close" onClick={closeReportModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <pre style={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-family)',
                fontSize: '0.875rem',
                lineHeight: '1.5',
                color: 'var(--gray-800)',
                margin: 0,
                padding: 0,
                maxHeight: '400px',
                overflowY: 'auto'
              }}>
                {reportContent}
              </pre>
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => downloadReport(reportSessionId, reportContent)}
              >
                📥 Download Report
              </button>
              <button className="btn btn-primary" onClick={closeReportModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Sessions;
