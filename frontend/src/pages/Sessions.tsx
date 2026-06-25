import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Session {
  id: string;
  start_time: string;
  end_time?: string;
  status: string;
  red_flags_detected: number;
  patient_name?: string;
  patient_phone?: string;
  estimated_cost?: number;
  language?: string;
}

// Short language badge label from the session's language code.
const LANG_LABEL: Record<string, string> = { 'te-IN': 'తెలుగు', 'hi-IN': 'हिंदी', 'en-IN': 'English' };

interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  pageSize: number;
}

interface SessionsResponse {
  sessions: Session[];
  pagination: PaginationInfo;
}

const Sessions: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [generatingReport, setGeneratingReport] = useState<string | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportContent, setReportContent] = useState<string>('');
  const [reportSessionId, setReportSessionId] = useState<string>('');
  const [isReportCached, setIsReportCached] = useState<boolean>(false);
  const [reportGeneratedAt, setReportGeneratedAt] = useState<string>('');
  // Doctor review state
  const [reportStatus, setReportStatus] = useState<string>('pending');
  const [reportReviewedBy, setReportReviewedBy] = useState<string | null>(null);
  const [isEditingReport, setIsEditingReport] = useState<boolean>(false);
  const [editedContent, setEditedContent] = useState<string>('');
  const [reviewing, setReviewing] = useState<boolean>(false);

  // Current user's role (stored as JSON in localStorage at login) — gates review actions.
  const currentRole = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role || ''; } catch { return ''; }
  })();
  const canReview = currentRole === 'doctor' || currentRole === 'admin';
  const isAdmin = currentRole === 'admin';   // only admins can delete sessions
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const navigate = useNavigate();

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async (page: number = 1, limit: number = 10) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/sessions?page=${page}&limit=${limit}`);
      const data: SessionsResponse = await response.json();

      if (data.sessions) {
        setSessions(data.sessions);
        setPagination(data.pagination);
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

  // Admin only: delete one session (and its data) after confirmation.
  const handleDeleteSession = async (sessionId: string) => {
    if (!window.confirm(`Delete session #${sessionId.slice(0, 8)} and all of its data?\nThis cannot be undone.`)) return;
    try {
      setDeletingId(sessionId);
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      console.error('Delete session failed:', err);
      setError('Failed to delete session');
    } finally {
      setDeletingId(null);
    }
  };

  // Admin only: delete ALL sessions (keeps patients) after confirmation.
  const handleDeleteAll = async () => {
    if (!window.confirm('Delete ALL sessions and their data?\nPatients are kept. This cannot be undone.')) return;
    try {
      setDeletingId('all');
      const res = await fetch('/api/sessions', { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      await fetchSessions(1, pagination?.pageSize || 10);
    } catch (err) {
      console.error('Delete all sessions failed:', err);
      setError('Failed to delete sessions');
    } finally {
      setDeletingId(null);
    }
  };

  const goToPage = (page: number) => {
    fetchSessions(page, pagination?.pageSize || 10);
  };

  const changePageSize = (newLimit: number) => {
    fetchSessions(1, newLimit);
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
        setIsReportCached(data.cached || false);
        setReportStatus(data.status || 'pending');
        setReportReviewedBy(data.reviewedBy || null);
        setIsEditingReport(false);
        setEditedContent(data.report);

        // Format timestamp for display
        if (data.generatedAt) {
          const generatedDate = new Date(data.generatedAt);
          const now = new Date();
          const diffMs = now.getTime() - generatedDate.getTime();
          const diffMins = Math.floor(diffMs / 60000);
          const diffHours = Math.floor(diffMins / 60);
          const diffDays = Math.floor(diffHours / 24);

          let timeMsg = '';
          if (diffMins < 1) {
            timeMsg = 'just now';
          } else if (diffMins < 60) {
            timeMsg = `${diffMins} minutes ago`;
          } else if (diffHours < 24) {
            timeMsg = `${diffHours} hours ago`;
          } else {
            timeMsg = `${diffDays} days ago`;
          }
          setReportGeneratedAt(timeMsg);
        }

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

  // Doctor saves edits / approves the report.
  const reviewReport = async (status: 'pending' | 'approved') => {
    try {
      setReviewing(true);
      const body: any = { status };
      if (isEditingReport) body.content = editedContent;
      const res = await fetch(`/api/sessions/${reportSessionId}/report/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setError('Failed to save review'); return; }
      const data = await res.json();
      if (isEditingReport) setReportContent(editedContent);
      setReportStatus(data.status);
      setReportReviewedBy(data.reviewedBy);
      setIsEditingReport(false);
    } catch {
      setError('Unable to save review');
    } finally {
      setReviewing(false);
    }
  };

  // Export the session as a FHIR R4 Bundle (for EMR/HIS ingestion).
  const exportFhir = async () => {
    try {
      const res = await fetch(`/api/sessions/${reportSessionId}/fhir`);
      if (!res.ok) { setError('Failed to export FHIR'); return; }
      const bundle = await res.json();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${reportSessionId}-fhir.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Unable to export FHIR');
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

  // Numbers-only display ID derived from the session UUID (stable per session, no '#'/letters).
  // The real UUID is still used for all actions/links and is shown on hover.
  const toNumericId = (id: string) => parseInt((id.replace(/[^0-9a-f]/gi, '').slice(0, 8) || '0'), 16).toString();

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
      <div className="sessions-header d-flex justify-content-between align-items-start gap-3">
        <div className="page-title">
          <h1>Medical Intake Sessions</h1>
          <p>View and manage all patient intake sessions</p>
        </div>
        {isAdmin && sessions.length > 0 && (
          <button
            className="btn btn-outline-danger btn-sm d-flex align-items-center gap-2 flex-shrink-0"
            onClick={handleDeleteAll}
            disabled={deletingId !== null}
            title="Delete all sessions (admin)"
          >
            <i className="fas fa-trash"></i>
            {deletingId === 'all' ? 'Deleting…' : 'Delete all'}
          </button>
        )}
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
                <div className="stat-number">{pagination?.totalCount || sessions.length}</div>
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
                <div className="stat-label">With Red Flags (Current Page)</div>

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
                <div className="stat-label">Completed (Current Page)</div>

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
          <div className="sessions-table-container" style={{ marginBottom: '20px' }}>
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Patient Name</th>
                  <th>Phone</th>
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
                    <td title={session.id}>{toNumericId(session.id)}</td>
                    <td>
                      {session.patient_name || <span className="no-flags">—</span>}
                      {session.language && (
                        <span className="badge bg-secondary ms-2 fw-normal">{LANG_LABEL[session.language] || session.language}</span>
                      )}
                    </td>
                    <td>
                      {session.patient_phone || <span className="no-flags">—</span>}
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
                        {isAdmin && (
                          <button
                            className="action-btn-sm danger"
                            onClick={() => handleDeleteSession(session.id)}
                            disabled={deletingId !== null}
                            title="Delete this session (admin)"
                          >
                            <span className="btn-icon-sm">🗑️</span>
                            {deletingId === session.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Controls */}
        {pagination && pagination.totalPages > 1 && (
          <div className="pagination-container">
            <div className="pagination-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <div className="pagination-info">
                  <span style={{ fontWeight: 'bold' }}>
                    Showing {((pagination.currentPage - 1) * pagination.pageSize) + 1} to{' '}
                    {Math.min(pagination.currentPage * pagination.pageSize, pagination.totalCount)} of{' '}
                    {pagination.totalCount} sessions
                  </span>
                </div>

                <div className="pagination-size-selector">
                  <label htmlFor="pageSize" style={{ fontWeight: 'bold' }}>Page size:</label>
                  <select
                    id="pageSize"
                    value={pagination.pageSize}
                    onChange={(e) => changePageSize(parseInt(e.target.value))}
                  >
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                  </select>
                </div>
              </div>

              <div className="pagination-buttons" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToPage(1)}
                  disabled={!pagination.hasPreviousPage}
                >
                  First
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToPage(pagination.currentPage - 1)}
                  disabled={!pagination.hasPreviousPage}
                >
                  Previous
                </button>

                <span className="pagination-page">
                  Page {pagination.currentPage} of {pagination.totalPages}
                </span>

                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToPage(pagination.currentPage + 1)}
                  disabled={!pagination.hasNextPage}
                >
                  Next
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToPage(pagination.totalPages)}
                  disabled={!pagination.hasNextPage}
                >
                  Last
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Report Modal */}
      {showReportModal && (
        <div className="modal-overlay" onClick={closeReportModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Medical Intake Report</h2>
              <div className="modal-subtitle" style={{ fontSize: '0.875rem', fontWeight: 500, marginTop: '0.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: isReportCached ? '#2563eb' : '#059669' }}>
                  {isReportCached ? '📋' : '✨'} Generated {reportGeneratedAt}
                </span>
                {reportStatus === 'approved' ? (
                  <span style={{ color: '#059669' }}>✅ Approved{reportReviewedBy ? ` by ${reportReviewedBy}` : ''}</span>
                ) : (
                  <span style={{ color: '#d97706' }}>⏳ Pending doctor review</span>
                )}
              </div>
              <button className="modal-close" onClick={closeReportModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              {isEditingReport ? (
                <textarea
                  value={editedContent}
                  onChange={(e) => setEditedContent(e.target.value)}
                  style={{ width: '100%', minHeight: '380px', fontFamily: 'var(--font-family)', fontSize: '0.875rem', lineHeight: 1.5, padding: '0.5rem' }}
                />
              ) : (
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
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => downloadReport(reportSessionId, reportContent)}
              >
                📥 Download
              </button>
              {canReview && (
                <button className="btn btn-secondary" onClick={exportFhir} title="Export as FHIR R4 Bundle for the hospital EMR">
                  🏥 Export FHIR
                </button>
              )}
              {canReview && !isEditingReport && (
                <button className="btn btn-secondary" onClick={() => { setEditedContent(reportContent); setIsEditingReport(true); }}>
                  ✏️ Edit
                </button>
              )}
              {canReview && isEditingReport && (
                <button className="btn btn-secondary" disabled={reviewing} onClick={() => reviewReport(reportStatus === 'approved' ? 'approved' : 'pending')}>
                  💾 Save edits
                </button>
              )}
              {canReview && reportStatus !== 'approved' && (
                <button className="btn btn-success" disabled={reviewing} onClick={() => reviewReport('approved')}>
                  {reviewing ? 'Saving…' : '✅ Approve'}
                </button>
              )}
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
