import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface DashboardStats {
  totalSessions: number;
  completedToday: number;
  redFlags: number;
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats>({
    totalSessions: 0,
    completedToday: 0,
    redFlags: 0
  });

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch sessions data
      const response = await fetch('http://localhost:3001/api/sessions');
      const data = await response.json();
      
      if (data.sessions) {
        const sessions = data.sessions;
        const today = new Date().toDateString();
        
        const todaySessions = sessions.filter((s: any) => 
          new Date(s.start_time).toDateString() === today
        );
        
        const completedSessions = sessions.filter((s: any) => s.status === 'completed');
        const totalRedFlags = sessions.reduce((sum: number, s: any) => sum + (s.red_flags_detected || 0), 0);
        
        setStats({
          totalSessions: sessions.length,
          completedToday: todaySessions.length,
          redFlags: totalRedFlags
        });

      }
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="page-title">
          <h1>Medical Intake Dashboard</h1>
          <p>Welcome back! Here's what's happening with your intake sessions today.</p>
        </div>
        <div className="dashboard-actions">
          <button className="btn btn-primary" onClick={() => navigate('/session')}>
            <span className="btn-icon">🎙️</span>
            Start New Session
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/analytics')}>
            <span className="btn-icon">📊</span>
            Generate Report
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card primary">
          <div className="stat-icon">📋</div>
          <div className="stat-content">
            <div className="stat-number">{stats.totalSessions}</div>
            <div className="stat-label">Total Sessions</div>
            <div className="stat-change positive">+12% from last week</div>
          </div>
        </div>

        <div className="stat-card success">
          <div className="stat-icon">✅</div>
          <div className="stat-content">
            <div className="stat-number">{stats.completedToday}</div>
            <div className="stat-label">Completed Today</div>
            <div className="stat-change positive">+5 from yesterday</div>
          </div>
        </div>

        <div className="stat-card warning">
          <div className="stat-icon">⚠️</div>
          <div className="stat-content">
            <div className="stat-number">{stats.redFlags}</div>
            <div className="stat-label">Red Flags</div>
            <div className="stat-change neutral">Requires attention</div>
          </div>
        </div>

      </div>

      <div className="dashboard-content">
        <div className="dashboard-main">

          <div className="alerts-section">
            <div className="section-header">
              <h2>Recent Alerts</h2>
              <button className="view-all-btn">View All</button>
            </div>
            <div className="alerts-list">
              <div className="alert-item critical">
                <div className="alert-icon">🚨</div>
                <div className="alert-content">
                  <div className="alert-title">Critical Red Flag Detected</div>
                  <div className="alert-description">Patient reported chest pain in Session #1234</div>
                  <div className="alert-time">2 minutes ago</div>
                </div>
                <button className="alert-action">Review</button>
              </div>
              
              <div className="alert-item warning">
                <div className="alert-icon">⚠️</div>
                <div className="alert-content">
                  <div className="alert-title">Session Timeout</div>
                  <div className="alert-description">Session #1233 exceeded 15-minute limit</div>
                  <div className="alert-time">15 minutes ago</div>
                </div>
                <button className="alert-action">Check</button>
              </div>
              
              <div className="alert-item info">
                <div className="alert-icon">ℹ️</div>
                <div className="alert-content">
                  <div className="alert-title">System Update</div>
                  <div className="alert-description">New AI model deployed successfully</div>
                  <div className="alert-time">1 hour ago</div>
                </div>
                <button className="alert-action">Details</button>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-sidebar">

          <div className="quick-actions">
            <div className="section-header">
              <h2>Quick Actions</h2>
            </div>
            <div className="actions-grid">
              <button className="action-card" onClick={() => navigate('/session')}>
                <div className="action-icon">🎙️</div>
                <div className="action-label">New Session</div>
              </button>
              <button className="action-card" onClick={() => navigate('/sessions')}>
                <div className="action-icon">📋</div>
                <div className="action-label">View Sessions</div>
              </button>
              <button className="action-card" onClick={() => navigate('/analytics')}>
                <div className="action-icon">📊</div>
                <div className="action-label">Reports</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;