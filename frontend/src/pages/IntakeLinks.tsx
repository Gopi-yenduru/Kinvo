import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// One generated remote-intake link as returned by GET /api/intake-links.
interface IntakeLink {
  id: string;
  token: string;
  patient_name?: string | null;
  phone?: string | null;
  language: string;
  status: string;
  displayStatus: string;     // folds in expiry + the linked session's live status
  session_id?: string | null;
  has_report?: boolean;
  created_at?: string;
  expires_at?: string | null;
}

interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
}

const LANG_LABEL: Record<string, string> = { 'te-IN': 'తెలుగు', 'hi-IN': 'हिंदी', 'en-IN': 'English' };
const LANG_OPTIONS = [
  { code: 'te-IN', label: 'తెలుగు', sub: 'Telugu' },
  { code: 'hi-IN', label: 'हिंदी', sub: 'Hindi' },
  { code: 'en-IN', label: 'English', sub: 'English' },
] as const;

// Bootstrap colour for each derived status.
const STATUS_COLOR: Record<string, string> = {
  pending: 'secondary',
  in_progress: 'warning',
  completed: 'success',
  expired: 'dark',
  revoked: 'danger',
  error: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  expired: 'Expired',
  revoked: 'Revoked',
  error: 'Error',
};

const IntakeLinks: React.FC = () => {
  const [links, setLinks] = useState<IntakeLink[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Generate-link modal + form.
  const [showModal, setShowModal] = useState(false);
  const [genName, setGenName] = useState('');
  const [genPhone, setGenPhone] = useState('');
  const [genLanguage, setGenLanguage] = useState<'te-IN' | 'hi-IN' | 'en-IN'>('te-IN');
  const [generating, setGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const navigate = useNavigate();

  useEffect(() => { fetchLinks(); }, []);

  const fetchLinks = async (page = 1, limit = 25) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/intake-links?page=${page}&limit=${limit}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setLinks(data.links || []);
      setPagination(data.pagination || null);
    } catch (err) {
      console.error('Failed to fetch intake links:', err);
      setError('Unable to load intake links');
    } finally {
      setLoading(false);
    }
  };

  const urlForToken = (token: string) => `${window.location.origin}/intake/${token}`;

  // Build a wa.me deep link that opens WhatsApp straight to the patient's number with the
  // message prefilled. India default: bare 10-digit numbers get the 91 country code; numbers
  // that already include a country code (longer) are used as-is. No number → contact picker.
  const waUrl = (phone: string | null | undefined, message: string) => {
    const digits = (phone || '').replace(/\D/g, '');
    const intl = digits.length === 10 ? `91${digits}` : digits;
    return `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
  };

  const copyLink = async (token: string) => {
    const url = urlForToken(token);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(prev => (prev === token ? null : prev)), 2000);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      window.prompt('Copy this link:', url);
    }
  };

  const shareWhatsApp = (link: IntakeLink) => {
    const url = urlForToken(link.token);
    const who = link.patient_name ? `${link.patient_name}, ` : '';
    const msg = `${who}please complete your pre-consultation voice intake before your appointment: ${url}`;
    window.open(waUrl(link.phone, msg), '_blank', 'noopener');
  };

  const openModal = () => {
    setGenName('');
    setGenPhone('');
    setGenLanguage('te-IN');
    setGeneratedUrl(null);
    setError('');
    setShowModal(true);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genPhone.trim()) { setError("Please enter the patient's phone number."); return; }
    try {
      setGenerating(true);
      setError('');
      const res = await fetch('/api/intake-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientName: genName.trim(), phone: genPhone.trim(), language: genLanguage }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || 'Failed to create link');
      }
      const data = await res.json();
      setGeneratedUrl(urlForToken(data.token));
      await fetchLinks(1, pagination?.pageSize || 25);
    } catch (err: any) {
      console.error('Failed to generate link:', err);
      setError(err.message || 'Failed to generate link');
    } finally {
      setGenerating(false);
    }
  };

  const revokeLink = async (id: string) => {
    if (!window.confirm('Revoke this link? The patient will no longer be able to use it.')) return;
    try {
      setRevokingId(id);
      const res = await fetch(`/api/intake-links/${id}/revoke`, { method: 'POST' });
      if (!res.ok) throw new Error('Revoke failed');
      await fetchLinks(pagination?.currentPage || 1, pagination?.pageSize || 25);
    } catch (err) {
      console.error('Failed to revoke link:', err);
      setError('Failed to revoke link');
    } finally {
      setRevokingId(null);
    }
  };

  // Permanently remove the link record from the list. Any completed intake session is kept
  // (it lives under Sessions / the patient record).
  const deleteLink = async (id: string) => {
    if (!window.confirm('Delete this link permanently?\nIt will be removed from the list. Any completed intake session is kept.')) return;
    try {
      setDeletingId(id);
      const res = await fetch(`/api/intake-links/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      // If we just removed the last row on a page, step back a page.
      const cur = pagination?.currentPage || 1;
      const goPage = links.length === 1 && cur > 1 ? cur - 1 : cur;
      await fetchLinks(goPage, pagination?.pageSize || 25);
    } catch (err) {
      console.error('Failed to delete link:', err);
      setError('Failed to delete link');
    } finally {
      setDeletingId(null);
    }
  };

  const fmtDate = (d?: string | null) => {
    if (!d) return '—';
    const dt = new Date(d);
    return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const copyGenerated = async () => {
    if (!generatedUrl) return;
    try { await navigator.clipboard.writeText(generatedUrl); }
    catch { window.prompt('Copy this link:', generatedUrl); }
  };

  if (loading) {
    return (
      <div className="sessions-loading">
        <div className="loading-spinner"></div>
        <p>Loading intake links...</p>
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <div className="sessions-header d-flex justify-content-between align-items-start gap-3">
        <div className="page-title">
          <h1>Patient Intake Links</h1>
          <p>Generate a secure link a patient opens on their own phone to complete the voice intake before their visit.</p>
        </div>
        <button className="btn btn-primary d-flex align-items-center gap-2 flex-shrink-0" onClick={openModal}>
          <i className="fas fa-plus"></i>
          Generate Link
        </button>
      </div>

      {error && !showModal && (
        <div className="error-alert">
          <div className="error-icon">⚠️</div>
          <div className="error-content">
            <h3>Error</h3>
            <p>{error}</p>
            <button className="error-dismiss" onClick={() => setError('')}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="sessions-content">
        {links.length === 0 ? (
          <div className="empty-sessions">
            <div className="empty-icon">🔗</div>
            <h3>No Links Yet</h3>
            <p>Generate a link for a patient and share it with them to start a remote intake.</p>
            <button className="btn btn-primary" onClick={openModal}>
              <span className="btn-icon">➕</span>
              Generate First Link
            </button>
          </div>
        ) : (
          <div className="sessions-table-container" style={{ marginBottom: '20px' }}>
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Phone</th>
                  <th>Language</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => {
                  const status = link.displayStatus || link.status;
                  const canRevoke = status === 'pending' || status === 'in_progress';
                  return (
                    <tr key={link.id}>
                      <td>{link.patient_name || <span className="no-flags">—</span>}</td>
                      <td>{link.phone || <span className="no-flags">—</span>}</td>
                      <td><span className="badge bg-secondary fw-normal">{LANG_LABEL[link.language] || link.language}</span></td>
                      <td><span className={`status-badge ${STATUS_COLOR[status] || 'secondary'}`}>{STATUS_LABEL[status] || status}</span></td>
                      <td>{fmtDate(link.created_at)}</td>
                      <td>{fmtDate(link.expires_at)}</td>
                      <td>
                        <div className="table-actions">
                          <button className="action-btn-sm primary" onClick={() => copyLink(link.token)} title="Copy the patient link">
                            <span className="btn-icon-sm">🔗</span>
                            {copiedToken === link.token ? 'Copied!' : 'Copy'}
                          </button>
                          <button className="action-btn-sm secondary" onClick={() => shareWhatsApp(link)} title="Share via WhatsApp">
                            <span className="btn-icon-sm">💬</span>
                            WhatsApp
                          </button>
                          {link.session_id && (status === 'completed' || status === 'in_progress' || status === 'error') && (
                            <button className="action-btn-sm secondary" onClick={() => navigate(`/sessions/${link.session_id}/transcript`)} title="View the intake result">
                              <span className="btn-icon-sm">📄</span>
                              View result
                            </button>
                          )}
                          {canRevoke && (
                            <button className="action-btn-sm danger" onClick={() => revokeLink(link.id)} disabled={revokingId !== null} title="Revoke this link">
                              <span className="btn-icon-sm">🚫</span>
                              {revokingId === link.id ? 'Revoking…' : 'Revoke'}
                            </button>
                          )}
                          <button className="action-btn-sm danger" onClick={() => deleteLink(link.id)} disabled={deletingId !== null} title="Delete this link permanently">
                            <span className="btn-icon-sm">🗑️</span>
                            {deletingId === link.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="pagination-container">
            <div className="pagination-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '20px' }}>
              <div className="pagination-info">
                <span style={{ fontWeight: 'bold' }}>
                  Page {pagination.currentPage} of {pagination.totalPages} • {pagination.totalCount} links
                </span>
              </div>
              <div className="pagination-buttons" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => fetchLinks(pagination.currentPage - 1, pagination.pageSize)} disabled={pagination.currentPage <= 1}>Previous</button>
                <span className="pagination-page">Page {pagination.currentPage} of {pagination.totalPages}</span>
                <button className="btn btn-sm btn-secondary" onClick={() => fetchLinks(pagination.currentPage + 1, pagination.pageSize)} disabled={pagination.currentPage >= pagination.totalPages}>Next</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Generate Link Modal */}
      {showModal && (
        <div className="modal fade show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => setShowModal(false)}>
          <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content border-0 shadow">
              <div className="modal-header bg-light">
                <h5 className="modal-title fw-semibold">{generatedUrl ? 'Link Ready' : 'Generate Patient Intake Link'}</h5>
                <button type="button" className="btn-close" onClick={() => setShowModal(false)}></button>
              </div>

              {!generatedUrl ? (
                <form onSubmit={handleGenerate}>
                  <div className="modal-body">
                    {error && <div className="alert alert-danger py-2">{error}</div>}

                    <div className="mb-3">
                      <label className="form-label fw-semibold">Patient name</label>
                      <input type="text" className="form-control form-control-lg" value={genName}
                        onChange={(e) => setGenName(e.target.value)} placeholder="e.g. Ravi Kumar" />
                      <div className="form-text"><i className="fas fa-microphone me-1"></i>The assistant still confirms the name and age by voice.</div>
                    </div>

                    <div className="mb-3">
                      <label htmlFor="genPhone" className="form-label fw-semibold">Patient phone number <span className="text-danger">*</span></label>
                      <input type="tel" id="genPhone" className="form-control form-control-lg" value={genPhone}
                        inputMode="numeric" pattern="[0-9]*"
                        onChange={(e) => setGenPhone(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 9876543210" />
                      <div className="form-text"><i className="fas fa-id-card me-1"></i>Ties the link to the patient record and pulls prior history for returning patients.</div>
                    </div>

                    <div className="mb-2">
                      <label className="form-label fw-semibold">Language / భాష / भाषा</label>
                      <div className="btn-group w-100" role="group" aria-label="Language selection">
                        {LANG_OPTIONS.map(opt => (
                          <button key={opt.code} type="button"
                            className={`btn ${genLanguage === opt.code ? 'btn-primary' : 'btn-outline-primary'} d-flex flex-column py-2`}
                            onClick={() => setGenLanguage(opt.code)}>
                            <span className="fw-semibold">{opt.label}</span>
                            <small className={genLanguage === opt.code ? 'text-white-50' : 'text-muted'}>{opt.sub}</small>
                          </button>
                        ))}
                      </div>
                      <div className="form-text">The patient can change this on the page before starting.</div>
                    </div>
                  </div>
                  <div className="modal-footer bg-light">
                    <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                    <button type="submit" className="btn btn-primary d-flex align-items-center gap-2" disabled={generating || !genPhone.trim()}>
                      <i className="fas fa-link"></i>
                      {generating ? 'Generating…' : 'Generate Link'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="modal-body">
                    <p className="text-success fw-semibold mb-2"><i className="fas fa-check-circle me-1"></i>Link created — valid for 24 hours.</p>
                    <p className="text-muted small mb-2">Send this link to the patient. They open it in any browser (no app, no login) and complete the voice intake.</p>
                    <div className="input-group mb-3">
                      <input type="text" className="form-control" readOnly value={generatedUrl} onFocus={(e) => e.target.select()} />
                      <button className="btn btn-primary" type="button" onClick={copyGenerated}><i className="fas fa-copy me-1"></i>Copy</button>
                    </div>
                    <div className="d-flex gap-2">
                      <a className="btn btn-outline-success flex-grow-1" href={waUrl(genPhone, `${genName ? genName + ', ' : ''}please complete your pre-consultation voice intake: ${generatedUrl}`)} target="_blank" rel="noopener noreferrer">
                        <i className="fab fa-whatsapp me-1"></i>{genPhone ? 'Send on WhatsApp' : 'Share on WhatsApp'}
                      </a>
                      <a className="btn btn-outline-secondary flex-grow-1" href={generatedUrl} target="_blank" rel="noopener noreferrer">
                        <i className="fas fa-external-link-alt me-1"></i>Open
                      </a>
                    </div>
                  </div>
                  <div className="modal-footer bg-light">
                    <button type="button" className="btn btn-secondary" onClick={openModal}>Generate Another</button>
                    <button type="button" className="btn btn-primary" onClick={() => setShowModal(false)}>Done</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default IntakeLinks;
