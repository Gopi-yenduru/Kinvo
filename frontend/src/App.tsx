import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import Transcript from './pages/Transcript';
import './App.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="session" element={<Session />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="sessions/:sessionId/transcript" element={<Transcript />} />
          <Route path="analytics" element={<div className="page-placeholder">
            <div className="placeholder-content">
              <h1>📊 Analytics</h1>
              <p>Advanced analytics and reporting dashboard coming soon...</p>
            </div>
          </div>} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
