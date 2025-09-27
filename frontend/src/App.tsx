import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import Transcript from './pages/Transcript';
import Login from './pages/Login';
import authService from './services/authService';
import './App.css';

// Global fetch interceptor for authentication
const originalFetch = window.fetch;
window.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
  const response = await originalFetch(url, options);

  // Handle authentication failures for protected API routes
  const urlString = typeof url === 'string' ? url : url.toString();
  if ((urlString.includes('/api/') && !urlString.includes('/api/login')) &&
      (response.status === 401 || response.status === 403)) {
    console.log('Authentication failed for protected API, clearing auth data');

    // Clear authentication data through the service
    authService.clearAuth();

    // The auth service will notify subscribers (like App component) of the change
    console.log('Auth data cleared, React will handle redirect to login');
  }

  return response;
};


function App() {
  const [authState, setAuthState] = useState(authService.getAuthState());

  // Subscribe to auth state changes
  useEffect(() => {
    const unsubscribe = authService.subscribe((newAuthState) => {
      console.log('App: Auth state changed:', newAuthState.token ? 'Authenticated' : 'Not authenticated');
      setAuthState(newAuthState);
    });

    // Initial load
    const initialState = authService.getAuthState();
    console.log('App: Initial auth state:', initialState.token ? 'Authenticated' : 'Not authenticated');
    setAuthState(initialState);

    return unsubscribe;
  }, []);

  const handleLoginSuccess = (token: string, user: string, userName: string) => {
    console.log('App: Login successful, setting auth data');
    authService.setAuth(token, user, userName);
  };

  const handleLogout = () => {
    console.log('App: Logout triggered, clearing auth data');
    authService.clearAuth();
  };

  return (
    <Router>
      <Routes>
        {/* Login route */}
        <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />

        {/* Protected routes */}
        {authState.token ? (
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
