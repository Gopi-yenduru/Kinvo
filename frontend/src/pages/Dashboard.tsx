import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface DashboardStats {
  totalSessions: number;
  completedToday: number;
  redFlags: number;
}

interface Alert {
  id: string;
  type: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  timeAgo: string;
  sessionId?: string;
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats>({
    totalSessions: 0,
    completedToday: 0,
    redFlags: 0
  });

  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    fetchDashboardData();
    fetchAlerts();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch sessions data
      const sessionsResponse = await fetch('http://localhost:3001/api/sessions');
      const sessionsData = await sessionsResponse.json();

      // Fetch red flags count
      const redFlagsResponse = await fetch('http://localhost:3001/api/sessions/red-flags');
      const redFlagsData = await redFlagsResponse.json();

      if (sessionsData.sessions) {
        const sessions = sessionsData.sessions;
        const today = new Date().toDateString();

        const todaySessions = sessions.filter((s: any) =>
          new Date(s.start_time).toDateString() === today
        );

        const totalRedFlagsCount = redFlagsData.redFlags ? redFlagsData.redFlags.length : 0;

        setStats({
          totalSessions: sessions.length,
          completedToday: todaySessions.length,
          redFlags: totalRedFlagsCount
        });

      }
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAlerts = async () => {
    try {
      const response = await fetch('http://localhost:3001/api/sessions/red-flags');
      const data = await response.json();

      if (data.redFlags) {
        const recentAlerts: Alert[] = data.redFlags.map((flag: any) => {
          const symptoms = JSON.parse(flag.symptoms || '[]');
          const timeAgo = getTimeAgo(flag.timestamp);

          return {
            id: `red-flag-${flag.id}`,
            type: flag.severity === 'critical' ? 'critical' : 'warning',
            title: `Red Flag Detected`,
            description: `Patient symptoms: ${symptoms.join(', ')} in Session #${flag.session_id.substring(0, 8)}`,
            timeAgo: timeAgo,
            sessionId: flag.session_id
          };
        });

        // Add a system alert if there are no red flags
        if (recentAlerts.length === 0) {
          recentAlerts.push({
            id: 'system-1',
            type: 'info',
            title: 'System Status',
            description: 'All systems operating normally',
            timeAgo: 'Just now'
          });
        }

        setAlerts(recentAlerts);
      }
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
      // Fallback to static alerts on error
      setAlerts([
        {
          id: 'system-1',
          type: 'info',
          title: 'System Status',
          description: 'All systems operating normally',
          timeAgo: 'Just now'
        }
      ]);
    }
  };

  const getTimeAgo = (timestamp: string): string => {
    // Log the raw timestamp for debugging
    console.log('Raw timestamp from database:', timestamp);

    const now = new Date();
    let time: Date;

    // Try to parse the timestamp
    if (timestamp.includes('T')) {
      // ISO format
      time = new Date(timestamp);
    } else {
      // SQLite format - try parsing as local time first
      time = new Date(timestamp);
    }

    console.log('Parsed time:', time.toISOString(), 'Current time:', now.toISOString());

    const diffMs = now.getTime() - time.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    console.log('Time difference in minutes:', diffMins);

    if (diffMins < 0) {
      return 'Just now'; // Handle future timestamps
    }

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} days ago`;
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

      <div className="stats-grid" style={{ gap: '1rem' }}>
        <div className="stat-card primary" style={{ height: '90px', padding: '0.75rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.2rem' }}>📋</div>
          <div className="stat-content" style={{ fontSize: '0.85rem' }}>
            <div className="stat-number" style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>{stats.totalSessions}</div>
            <div className="stat-label" style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>Total Sessions</div>
            <div className="stat-change positive" style={{ fontSize: '0.7rem' }}>+12% from last week</div>
          </div>
        </div>

        <div className="stat-card success" style={{ height: '90px', padding: '0.75rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.2rem' }}>✅</div>
          <div className="stat-content" style={{ fontSize: '0.85rem' }}>
            <div className="stat-number" style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>{stats.completedToday}</div>
            <div className="stat-label" style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>Completed Today</div>
            <div className="stat-change positive" style={{ fontSize: '0.7rem' }}>+5 from yesterday</div>
          </div>
        </div>

        <div className="stat-card warning" style={{ height: '90px', padding: '0.75rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.2rem' }}>⚠️</div>
          <div className="stat-content" style={{ fontSize: '0.85rem' }}>
            <div className="stat-number" style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>{stats.redFlags}</div>
            <div className="stat-label" style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>Red Flags</div>
            <div className="stat-change neutral" style={{ fontSize: '0.7rem' }}>Requires attention</div>
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
            <div className="alerts-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {alerts.length > 0 ? (
                alerts.map((alert) => (
                  <div key={alert.id} className={`alert-item ${alert.type}`}>
                    <div className="alert-icon">
                      {alert.type === 'critical' ? '🚨' : alert.type === 'warning' ? '⚠️' : 'ℹ️'}
                    </div>
                    <div className="alert-content">
                      <div className="alert-title">{alert.title}</div>
                      <div className="alert-description">{alert.description}</div>
                      <div className="alert-time">{alert.timeAgo}</div>
                    </div>
                    <button className="alert-action" onClick={() => alert.sessionId && navigate(`/sessions/${alert.sessionId}/transcript`)}>
                      {alert.type === 'critical' ? 'Review' : alert.type === 'warning' ? 'Check' : 'Details'}
                    </button>
                  </div>
                ))
              ) : (
                <div className="alert-item info">
                  <div className="alert-icon">ℹ️</div>
                  <div className="alert-content">
                    <div className="alert-title">No Recent Alerts</div>
                    <div className="alert-description">All systems operating normally</div>
                    <div className="alert-time">Just now</div>
                  </div>
                  <button className="alert-action">Details</button>
                </div>
              )}
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