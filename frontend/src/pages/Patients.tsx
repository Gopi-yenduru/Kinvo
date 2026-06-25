import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Patient {
  id: number;
  name?: string;
  phone?: string;
  age?: string;
  visit_count: number;
  medical_summary?: string;
  first_visit_at?: string;
  last_visit_at?: string;
}

interface PatientSession {
  id: string;
  start_time: string;
  status: string;
  language?: string;
  red_flags_detected: number;
}

const LANG_LABEL: Record<string, string> = { 'te-IN': 'తెలుగు', 'hi-IN': 'हिंदी', 'en-IN': 'English' };
const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : '—');

const Patients: React.FC = () => {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Detail modal
  const [selected, setSelected] = useState<Patient | null>(null);
  const [sessions, setSessions] = useState<PatientSession[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Current user's role (stored as JSON in localStorage at login) — only admins can delete.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; }
  })();

  useEffect(() => { fetchPatients(page); }, [page]);

  const fetchPatients = async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients?page=${p}&limit=25`);
      if (!res.ok) throw new Error('Failed to load patients');
      const data = await res.json();
      setPatients(data.patients || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch (e: any) {
      setError(e.message || 'Failed to load patients');
    } finally {
      setLoading(false);
    }
  };

  // Admin only: delete a patient and ALL of their visits/sessions after confirmation.
  const handleDeletePatient = async (p: Patient) => {
    const who = p.name || p.phone || `#${p.id}`;
    if (!window.confirm(`Delete patient ${who} and ALL of their visits/sessions and data?\nThis cannot be undone.`)) return;
    setDeletingId(p.id);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${p.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      if (selected?.id === p.id) setSelected(null);   // close the modal if this patient was open
      // If we just removed the last row on a page, step back a page.
      const nextPage = patients.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) setPage(nextPage); else await fetchPatients(page);
    } catch (err) {
      console.error('Delete patient failed:', err);
      setError('Failed to delete patient');
    } finally {
      setDeletingId(null);
    }
  };

  const openPatient = async (id: number) => {
    setDetailLoading(true);
    setSelected({ id } as Patient);
    setSessions([]);
    try {
      const res = await fetch(`/api/patients/${id}`);
      if (!res.ok) throw new Error('Failed to load patient');
      const data = await res.json();
      setSelected(data.patient);
      setSessions(data.sessions || []);
    } catch {
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="w-100">
      <div className="container-fluid px-3 px-md-4 py-3 py-md-4">
        <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="h2 fw-bold text-primary mb-1">Patients</h1>
            <p className="text-muted mb-0">{total} patient{total === 1 ? '' : 's'} on record — returning patients keep their history across visits.</p>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-5"><div className="loading-spinner"></div><p className="text-muted mt-2">Loading patients…</p></div>
        ) : error ? (
          <div className="alert alert-danger">{error}</div>
        ) : patients.length === 0 ? (
          <div className="alert alert-info">No patients yet. They are created when you start a session with a phone / patient ID.</div>
        ) : (
          <>
            <div className="table-responsive border rounded-3">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th>Name</th><th>Phone / ID</th><th>Age</th><th>Visits</th><th>Last visit</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map(p => (
                    <tr key={p.id}>
                      <td className="fw-semibold">{p.name || <span className="text-muted">—</span>}</td>
                      <td>{p.phone || <span className="text-muted">—</span>}</td>
                      <td>{p.age || '—'}</td>
                      <td><span className="badge bg-primary-subtle text-primary">{p.visit_count}</span></td>
                      <td>{fmtDate(p.last_visit_at)}</td>
                      <td className="text-end">
                        <button className="btn btn-sm btn-outline-primary" onClick={() => openPatient(p.id)}>
                          <i className="fas fa-folder-open me-1"></i> View
                        </button>
                        {isAdmin && (
                          <button
                            className="btn btn-sm btn-outline-danger ms-2"
                            onClick={() => handleDeletePatient(p)}
                            disabled={deletingId === p.id}
                            title="Delete this patient and all their visits (admin)"
                          >
                            <i className="fas fa-trash me-1"></i>
                            {deletingId === p.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="d-flex justify-content-between align-items-center mt-3">
                <button className="btn btn-outline-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span className="text-muted small">Page {page} of {totalPages}</span>
                <button className="btn btn-outline-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Patient detail modal */}
      {selected && (
        <div className="modal fade show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }} onClick={() => setSelected(null)}>
          <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content border-0 shadow">
              <div className="modal-header bg-light">
                <h5 className="modal-title fw-semibold">
                  {selected.name || 'Patient'} {selected.phone && <span className="text-muted fw-normal">· {selected.phone}</span>}
                </h5>
                <button type="button" className="btn-close" onClick={() => setSelected(null)}></button>
              </div>
              <div className="modal-body">
                {detailLoading ? (
                  <div className="text-center py-4"><div className="loading-spinner"></div></div>
                ) : (
                  <>
                    <div className="row g-2 mb-3">
                      <div className="col-6 col-md-3"><div className="text-muted small">Age</div><div className="fw-semibold">{selected.age || '—'}</div></div>
                      <div className="col-6 col-md-3"><div className="text-muted small">Visits</div><div className="fw-semibold">{selected.visit_count}</div></div>
                      <div className="col-6 col-md-3"><div className="text-muted small">First visit</div><div className="fw-semibold">{fmtDate(selected.first_visit_at)}</div></div>
                      <div className="col-6 col-md-3"><div className="text-muted small">Last visit</div><div className="fw-semibold">{fmtDate(selected.last_visit_at)}</div></div>
                    </div>

                    <h6 className="fw-semibold">Medical history (across visits)</h6>
                    {selected.medical_summary ? (
                      <pre className="bg-light border rounded-3 p-3 small mb-3" style={{ whiteSpace: 'pre-wrap', maxHeight: '260px', overflowY: 'auto' }}>{selected.medical_summary}</pre>
                    ) : (
                      <p className="text-muted small">No history recorded yet.</p>
                    )}

                    <h6 className="fw-semibold">Visits ({sessions.length})</h6>
                    {sessions.length === 0 ? (
                      <p className="text-muted small mb-0">No visits found.</p>
                    ) : (
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-0">
                          <thead><tr><th>Date</th><th>Language</th><th>Status</th><th>Red flags</th><th></th></tr></thead>
                          <tbody>
                            {sessions.map(s => (
                              <tr key={s.id}>
                                <td>{new Date(s.start_time).toLocaleString()}</td>
                                <td>{s.language ? (LANG_LABEL[s.language] || s.language) : '—'}</td>
                                <td><span className="badge bg-secondary-subtle text-secondary">{s.status}</span></td>
                                <td>{s.red_flags_detected > 0 ? <span className="text-danger">⚠️ {s.red_flags_detected}</span> : '—'}</td>
                                <td className="text-end">
                                  <button className="btn btn-sm btn-link p-0" onClick={() => { setSelected(null); navigate(`/sessions/${s.id}/transcript`); }}>Transcript</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="modal-footer bg-light">
                {isAdmin && selected.id && (
                  <button
                    className="btn btn-outline-danger me-auto"
                    onClick={() => handleDeletePatient(selected)}
                    disabled={deletingId === selected.id}
                    title="Delete this patient and all their visits (admin)"
                  >
                    <i className="fas fa-trash me-1"></i>
                    {deletingId === selected.id ? 'Deleting…' : 'Delete patient'}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Patients;
