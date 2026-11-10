import React, { useState } from 'react';
import { useNavigate } from "react-router-dom";
import authService from '../services/authService';

interface LoginProps {
  onLoginSuccess: (token: string, user: string, userName: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Invalid login credentials');
      }

      const { token, userData } = data;

      // ✅ Save auth data using the auth service
      const userString = JSON.stringify(userData);
      const userName = userData?.username || '';
      authService.setAuth(token, userString, userName);

      // ✅ Update parent App state
      onLoginSuccess(token, userString, userName);

      // ✅ Redirect to dashboard
      navigate("/");
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="k-auth">
      {/* Brand panel (hidden on narrow screens) */}
      <aside className="k-auth-brand">
        <div className="k-auth-logo">
          <span className="k-auth-mark"><i className="fas fa-wave-square"></i></span>
          Kinvo
        </div>
        <div className="k-auth-headline">
          <h1>Every patient heard, before the doctor walks in.</h1>
          <p>A kind AI voice nurse that takes the pre-consultation history in Telugu, Hindi or English and hands your doctors a clear summary.</p>
          <ul className="k-auth-points">
            <li><i className="fas fa-language"></i> Speaks the patient's own language</li>
            <li><i className="fas fa-triangle-exclamation"></i> Flags emergencies instantly</li>
            <li><i className="fas fa-file-medical"></i> Doctor-ready, FHIR-exportable reports</li>
          </ul>
        </div>
        <div className="k-auth-foot">For authorised hospital staff only.</div>
      </aside>

      <main className="k-auth-panel">
        <div className="k-auth-card">
          <div className="k-auth-logo k-auth-mobile-logo">
            <span className="k-auth-mark" style={{ background: 'var(--k-brand)', color: '#fff' }}><i className="fas fa-wave-square"></i></span>
            Kinvo
          </div>
          <h2>Welcome back</h2>
          <p className="k-sub">Sign in to continue to your dashboard.</p>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label className="form-label" htmlFor="login-username">Username</label>
              <input
                id="login-username"
                type="text"
                className="form-control"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="mb-4">
              <label className="form-label" htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                className="form-control"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="btn btn-primary w-100" disabled={loading}>
              {loading
                ? <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Signing in…</>
                : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
};

export default Login;
