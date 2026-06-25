import React, { useEffect, useState } from 'react';

interface CostByModel { model: string; cost: number; }
interface UsageSummary {
  totalSessions: number;
  totalCost: number;
  averageCostPerSession: number;
  totalAudioTokens: number;
  totalTextTokens: number;
  costByModel: CostByModel[];
}
interface DashboardSummary {
  activeSessions: number;
  pausedSessions: number;
  totalSessions: number;
  sessionsWithRedFlags: number;
}
interface PeriodSummary { totalSessions: number; totalCost: number; modelsUsed: string[]; }

const PERIODS = [
  { key: '7days', label: 'Last 7 days' },
  { key: '30days', label: 'Last 30 days' },
  { key: '90days', label: 'Last 90 days' },
];

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('jwt_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const Analytics: React.FC = () => {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [period, setPeriod] = useState<string>('7days');
  const [periodSummary, setPeriodSummary] = useState<PeriodSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, d] = await Promise.all([
        fetch('/api/analytics/token-usage', { headers: authHeaders() }),
        fetch('/api/dashboard/summary'),
      ]);
      if (!u.ok) throw new Error('Failed to load usage analytics');
      const uj = await u.json();
      const dj = await d.json();
      setUsage(uj.usage);
      setDashboard(dj.summary);
    } catch (e: any) {
      setError(e?.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const loadPeriod = async (p: string) => {
    try {
      const r = await fetch(`/api/analytics/token-usage/${p}`, { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      setPeriodSummary(j.usage?.periodSummary || null);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { loadPeriod(period); }, [period]);

  const money = (n: number) => `$${(n || 0).toFixed(4)}`;
  const num = (n: number) => (n || 0).toLocaleString();

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <div className="dashboard w-100">
      <div className="container-fluid px-3 px-md-4 py-3 py-md-4">
        <div className="dashboard-header mb-4 d-flex justify-content-between align-items-start flex-wrap gap-2">
          <div className="page-title">
            <h1 className="h2 fw-bold text-primary mb-2">📊 Analytics</h1>
            <p className="text-muted mb-0">Usage, cost and session insights for your intake sessions.</p>
          </div>
          <button className="btn btn-outline-secondary d-flex align-items-center gap-2" onClick={loadAll}>
            <i className="fas fa-rotate-right"></i> Refresh
          </button>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">{error}</div>
        )}

        {/* Top-line stats */}
        <div className="row g-3 g-md-4 mb-4">
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card primary h-100">
              <div className="stat-icon"><i className="fas fa-clipboard-list"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(dashboard?.totalSessions ?? usage?.totalSessions ?? 0)}</div>
                <div className="stat-label">Total Sessions</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card success h-100">
              <div className="stat-icon"><i className="fas fa-dollar-sign"></i></div>
              <div className="stat-content">
                <div className="stat-number">{money(usage?.totalCost ?? 0)}</div>
                <div className="stat-label">Total Cost</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card info h-100">
              <div className="stat-icon"><i className="fas fa-coins"></i></div>
              <div className="stat-content">
                <div className="stat-number">{money(usage?.averageCostPerSession ?? 0)}</div>
                <div className="stat-label">Avg Cost / Session</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card warning h-100">
              <div className="stat-icon"><i className="fas fa-triangle-exclamation"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(dashboard?.sessionsWithRedFlags ?? 0)}</div>
                <div className="stat-label">Sessions with Red Flags</div>
              </div>
            </div>
          </div>
        </div>

        {/* Tokens + live sessions */}
        <div className="row g-3 g-md-4 mb-4">
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card h-100">
              <div className="stat-icon"><i className="fas fa-font"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(usage?.totalTextTokens ?? 0)}</div>
                <div className="stat-label">Text Tokens</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card h-100">
              <div className="stat-icon"><i className="fas fa-waveform"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(usage?.totalAudioTokens ?? 0)}</div>
                <div className="stat-label">Audio Tokens</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card h-100">
              <div className="stat-icon"><i className="fas fa-circle-play"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(dashboard?.activeSessions ?? 0)}</div>
                <div className="stat-label">Active Now</div>
              </div>
            </div>
          </div>
          <div className="col-12 col-sm-6 col-lg-3">
            <div className="stat-card h-100">
              <div className="stat-icon"><i className="fas fa-pause"></i></div>
              <div className="stat-content">
                <div className="stat-number">{num(dashboard?.pausedSessions ?? 0)}</div>
                <div className="stat-label">Paused</div>
              </div>
            </div>
          </div>
        </div>

        <div className="row g-3 g-md-4">
          {/* Cost by model */}
          <div className="col-12 col-lg-6">
            <div className="card h-100">
              <div className="card-header fw-semibold">Cost by Model</div>
              <div className="card-body">
                {usage && usage.costByModel.length > 0 ? (
                  <table className="table table-sm mb-0">
                    <thead><tr><th>Model</th><th className="text-end">Cost</th></tr></thead>
                    <tbody>
                      {usage.costByModel.map((m) => (
                        <tr key={m.model}><td>{m.model}</td><td className="text-end">{money(m.cost)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-muted mb-0">No usage recorded yet. Complete a session to see cost data.</p>
                )}
              </div>
            </div>
          </div>

          {/* Period summary */}
          <div className="col-12 col-lg-6">
            <div className="card h-100">
              <div className="card-header d-flex justify-content-between align-items-center">
                <span className="fw-semibold">Period Summary</span>
                <select className="form-select form-select-sm w-auto" value={period} onChange={(e) => setPeriod(e.target.value)}>
                  {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div className="card-body">
                {periodSummary ? (
                  <ul className="list-unstyled mb-0">
                    <li className="d-flex justify-content-between py-1"><span className="text-muted">Sessions</span><strong>{num(periodSummary.totalSessions)}</strong></li>
                    <li className="d-flex justify-content-between py-1"><span className="text-muted">Cost</span><strong>{money(periodSummary.totalCost)}</strong></li>
                    <li className="d-flex justify-content-between py-1"><span className="text-muted">Models used</span><strong>{periodSummary.modelsUsed.length ? periodSummary.modelsUsed.join(', ') : '—'}</strong></li>
                  </ul>
                ) : (
                  <p className="text-muted mb-0">No data for this period.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Analytics;
