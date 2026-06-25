import React, { useEffect, useState } from 'react';

interface User { id: string; username: string; email: string; role: string; created_at: string; }

const ROLES = ['doctor', 'nurse', 'clinician', 'admin'];

const Users: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'clinician' });

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/users');
      if (r.status === 403) { setError('Only administrators can manage users.'); setUsers([]); return; }
      if (!r.ok) throw new Error('Failed to load users');
      const j = await r.json();
      setUsers(j.users || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setNotice(null);
    if (form.username.trim().length < 3) { setError('Username must be at least 3 characters.'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    try {
      setSaving(true);
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || 'Failed to create user'); return; }
      setNotice(`Created ${j.username} (${j.role}).`);
      setForm({ username: '', email: '', password: '', role: 'clinician' });
      load();
    } catch {
      setError('Unable to create user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard w-100">
      <div className="container-fluid px-3 px-md-4 py-3 py-md-4">
        <div className="dashboard-header mb-4">
          <h1 className="h2 fw-bold text-primary mb-2">👥 User Management</h1>
          <p className="text-muted mb-0">Create and manage staff accounts (doctor, nurse, clinician, admin).</p>
        </div>

        {error && <div className="alert alert-danger">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <div className="row g-3 g-md-4">
          {/* Create user */}
          <div className="col-12 col-lg-5">
            <div className="card">
              <div className="card-header fw-semibold">Add a user</div>
              <div className="card-body">
                <form onSubmit={createUser}>
                  <div className="mb-3">
                    <label className="form-label">Username</label>
                    <input className="form-control" value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Email</label>
                    <input className="form-control" type="email" value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Password</label>
                    <input className="form-control" type="password" value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
                    <small className="text-muted">Minimum 8 characters.</small>
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Role</label>
                    <select className="form-select" value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-primary w-100" type="submit" disabled={saving}>
                    {saving ? 'Creating…' : 'Create user'}
                  </button>
                </form>
              </div>
            </div>
          </div>

          {/* User list */}
          <div className="col-12 col-lg-7">
            <div className="card">
              <div className="card-header d-flex justify-content-between align-items-center">
                <span className="fw-semibold">Staff accounts</span>
                <button className="btn btn-sm btn-outline-secondary" onClick={load}>Refresh</button>
              </div>
              <div className="card-body p-0">
                {loading ? (
                  <div className="p-3 text-muted">Loading…</div>
                ) : users.length === 0 ? (
                  <div className="p-3 text-muted">No users to show.</div>
                ) : (
                  <table className="table table-sm mb-0 align-middle">
                    <thead><tr><th className="ps-3">Username</th><th>Email</th><th>Role</th></tr></thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td className="ps-3">{u.username}</td>
                          <td className="text-muted">{u.email || '—'}</td>
                          <td><span className="badge bg-secondary text-capitalize">{u.role}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Users;
