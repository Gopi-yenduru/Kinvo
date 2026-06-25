import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import Transcript from './pages/Transcript';
import Analytics from './pages/Analytics';
import Patients from './pages/Patients';
import Users from './pages/Users';
import IntakeLinks from './pages/IntakeLinks';
import PatientIntake from './pages/PatientIntake';
import Login from './pages/Login';
import authService from './services/authService';
import { SessionProvider } from './contexts/SessionContext';
import './App.css';

// Global fetch interceptor: inject the JWT on protected API calls + handle auth failures.
const originalFetch = window.fetch;
window.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
  const urlString = typeof url === 'string' ? url : url.toString();
  const isProtectedApi = urlString.includes('/api/') && !urlString.includes('/api/login');

  // Attach the bearer token so the backend's auth gate accepts the request.
  if (isProtectedApi) {
    const token = localStorage.getItem('jwt_token');
    if (token) {
      const headers = new Headers((options && options.headers) || {});
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      options = { ...(options || {}), headers };
    }
  }

  const response = await originalFetch(url, options);

  // Handle authentication failures for protected API routes
  if (isProtectedApi && (response.status === 401 || response.status === 403)) {
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
    <SessionProvider>
      <Router>
        <Routes>
          {/* Login route */}
          <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />

          {/* PUBLIC patient intake link — no login. Declared before the auth gate so the
              unauthenticated catch-all redirect to /login can never swallow it. */}
          <Route path="/intake/:token" element={<PatientIntake />} />

          {/* Protected routes */}
          {authState.token ? (
            <Route path="/" element={<Layout onLogout={handleLogout} />}>
              <Route index element={<Dashboard />} />
              <Route path="session" element={<Session />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="sessions/:sessionId/transcript" element={<Transcript />} />
              <Route path="patients" element={<Patients />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="intake-links" element={<IntakeLinks />} />
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          ) : (
            // Redirect to login if not authenticated
            <Route path="*" element={<Navigate to="/login" replace />} />
          )}
        </Routes>
      </Router>
    </SessionProvider>
  );
}

export default App;
