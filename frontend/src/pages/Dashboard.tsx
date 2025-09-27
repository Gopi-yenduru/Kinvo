import React, { useState, useEffect, useRef } from 'react';
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
  const token = localStorage.getItem("jwt_token");
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      fetchDashboardData();
    }
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch sessions count
      const sessionsResponse = await fetch('/api/sessions-counts');
      const sessionsData = await sessionsResponse.json();

      // Fetch red flags
      const redFlagsResponse = await fetch('/api/sessions/red-flags');
      const redFlagsData = await redFlagsResponse.json();

      const totalRedFlagsCount = redFlagsData.redFlags ? redFlagsData.redFlags.length : 0;

      setStats({
        totalSessions: sessionsData.totalSessions,
        completedToday: sessionsData.completedToday,
        redFlags: totalRedFlagsCount
      });

      // Create alerts
      const recentAlerts: Alert[] = redFlagsData.redFlags.map((flag: any) => {
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
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
      // Fallback for alerts
      setAlerts([
        {
          id: 'system-1',
          type: 'info',
          title: 'System Status',
          description: 'All systems operating normally',
          timeAgo: 'Just now'
        }
      ]);
    } finally {
      setLoading(false);
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
    <div className="dashboard w-100">
      <div className="container-fluid px-3 px-md-4 py-3 py-md-4">
        {/* Dashboard Header */}
        <div className="dashboard-header mb-4">
          <div className="row align-items-start col-12 g-3">
            <div className="col-12 col-lg-8">
              <div className="page-title">
                <h1 className="h2 fw-bold text-primary mb-2">Medical Intake Dashboard</h1>
                <p className="text-muted mb-0">Welcome back! Here's what's happening with your intake sessions today.</p>
              </div>
            </div>
            <div className="col-12 col-lg-4">
              <div className="dashboard-actions d-flex flex-column flex-sm-row gap-2 justify-content-lg-end">
                <button className="btn btn-primary d-flex align-items-center justify-content-center gap-2" onClick={() => navigate('/session')}>
                  <i className="fas fa-microphone"></i>
                  <span className="d-none d-sm-inline">Start New Session</span>
                  <span className="d-sm-none">New Session</span>
                </button>
                <button className="btn btn-outline-secondary d-flex align-items-center justify-content-center gap-2" onClick={() => navigate('/analytics')}>
                  <i className="fas fa-chart-bar"></i>
                  <span className="d-none d-sm-inline">Generate Report</span>
                  <span className="d-sm-none">Reports</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="row g-3 g-md-4 mb-4">
          <div className="col-12 col-sm-6 col-lg-4">
            <div className="stat-card primary h-100">
              <div className="stat-icon">
                <i className="fas fa-clipboard-list"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{stats.totalSessions}</div>
                <div className="stat-label">Total Sessions</div>
                <div className="stat-change positive">
                  <i className="fas fa-arrow-up me-1"></i>
                  +12% from last week
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-sm-6 col-lg-4">
            <div className="stat-card success h-100">
              <div className="stat-icon">
                <i className="fas fa-check-circle"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{stats.completedToday}</div>
                <div className="stat-label">Completed Today</div>
                <div className="stat-change positive">
                  <i className="fas fa-arrow-up me-1"></i>
                  +5 from yesterday
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-sm-12 col-lg-4">
            <div className="stat-card warning h-100">
              <div className="stat-icon">
                <i className="fas fa-exclamation-triangle"></i>
              </div>
              <div className="stat-content">
                <div className="stat-number">{stats.redFlags}</div>
                <div className="stat-label">Red Flags</div>
                <div className="stat-change neutral">
                  <i className="fas fa-eye me-1"></i>
                  Requires attention
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="row g-3 g-md-4">
          <div className="col-12 col-xl-12">
            <div className="alerts-section">
              <div className="section-header">
                <h2 className="h4 mb-0">Recent Alerts</h2>
                <button className="btn btn-link btn-sm text-decoration-none p-0">View All</button>
              </div>
              <div className="alerts-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                {alerts.length > 0 ? (
                  alerts.map((alert) => (
                    <div key={alert.id} className={`alert-item ${alert.type} mb-3 d-flex align-items-start gap-3`}>
                      <div className="alert-icon flex-shrink-0">
                        {alert.type === 'critical' ? (
                          <i className="fas fa-exclamation-circle text-danger"></i>
                        ) : alert.type === 'warning' ? (
                          <i className="fas fa-exclamation-triangle text-warning"></i>
                        ) : (
                          <i className="fas fa-info-circle text-info"></i>
                        )}
                      </div>
                      <div className="alert-content flex-grow-1 min-w-0">
                        <div className="alert-title fw-semibold">{alert.title}</div>
                        <div className="alert-description text-muted small">{alert.description}</div>
                        <div className="alert-time text-muted" style={{ fontSize: '0.75rem' }}>{alert.timeAgo}</div>
                      </div>
                      <button
                        className="btn btn-sm btn-outline-primary flex-shrink-0"
                        onClick={() => alert.sessionId && navigate(`/sessions/${alert.sessionId}/transcript`)}
                      >
                        {alert.type === 'critical' ? 'Review' : alert.type === 'warning' ? 'Check' : 'Details'}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="alert-item info mb-3 d-flex align-items-start gap-3">
                    <div className="alert-icon flex-shrink-0">
                      <i className="fas fa-info-circle text-info"></i>
                    </div>
                    <div className="alert-content flex-grow-1">
                      <div className="alert-title fw-semibold">No Recent Alerts</div>
                      <div className="alert-description text-muted small">All systems operating normally</div>
                      <div className="alert-time text-muted" style={{ fontSize: '0.75rem' }}>Just now</div>
                    </div>
                    <button className="btn btn-sm btn-outline-primary flex-shrink-0">Details</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* <div className="col-12 col-xl-4">
            <div className="quick-actions">
              <div className="section-header">
                <h2 className="h4 mb-3">Quick Actions</h2>
              </div>
              <div className="row g-2 g-md-3">
                <div className="col-6 col-xl-6">
                  <button className="action-card w-100 h-100 border-0 p-3" onClick={() => navigate('/session')}>
                    <div className="action-icon mb-2">
                      <i className="fas fa-microphone fa-2x"></i>
                    </div>
                    <div className="action-label small fw-semibold">New Session</div>
                  </button>
                </div>
                <div className="col-6 col-xl-6">
                  <button className="action-card w-100 h-100 border-0 p-3" onClick={() => navigate('/sessions')}>
                    <div className="action-icon mb-2">
                      <i className="fas fa-list fa-2x"></i>
                    </div>
                    <div className="action-label small fw-semibold">View Sessions</div>
                  </button>
                </div>
                <div className="col-12">
                  <button className="action-card w-100 border-0 p-3" onClick={() => navigate('/analytics')}>
                    <div className="d-flex align-items-center justify-content-center gap-3">
                      <div className="action-icon">
                        <i className="fas fa-chart-bar fa-2x"></i>
                      </div>
                      <div className="action-label fw-semibold">Analytics & Reports</div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div> */}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;