import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import Transcript from './pages/Transcript';
import Login from './pages/Login';
import './App.css';

function App() {
  const [token, setToken] = useState<string | null>(null);

  // Load token from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('jwt_token');
    if (savedToken) setToken(savedToken);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    setToken(null);
  };

  return (
    <Router>
      <Routes>
        {/* Login route */}
        <Route path="/login" element={<Login onLoginSuccess={setToken} />} />

        {/* Protected routes */}
        {token ? (
          <Route path="/" element={<Layout onLogout={handleLogout} />}>
            <Route index element={<Dashboard />} />
            <Route path="session" element={<Session />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:sessionId/transcript" element={<Transcript />} />
            <Route
              path="analytics"
              element={
                <div className="page-placeholder">
                  <div className="placeholder-content">
                    <h1>📊 Analytics</h1>
                    <p>Advanced analytics and reporting dashboard coming soon...</p>
                  </div>
                </div>
              }
            />
            <Route path="settings" element={<Settings />} />
          </Route>
        ) : (
          // Redirect to login if not authenticated
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </Router>
  );
}

export default App;
