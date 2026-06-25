import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * NotificationBell — a live header bell that surfaces things a clinician must act on:
 *   • Red-flag alerts  — urgent symptoms detected in recent intakes (GET /api/sessions/red-flags)
 *   • Completed remote intakes — patients who finished a shared-link intake (admin: GET /api/intake-links)
 *
 * A red badge counts items newer than the last time the dropdown was opened (tracked in
 * localStorage). Clicking an item opens that session's transcript. Polls every 60s.
 */

interface NotifItem {
  id: string;
  kind: 'red_flag' | 'completed_intake';
  sessionId: string | null;
  title: string;
  detail: string;
  severity?: string;
  time: number; // epoch ms
}

// Red-flag symptoms may be stored as a JSON array string or a plain string — render both nicely.
const formatSymptoms = (raw: any): string => {
  if (!raw) return 'Urgent symptoms detected';
  if (typeof raw === 'string') {
    try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.join(', '); } catch { /* plain string */ }
    return raw;
  }
  return String(raw);
};

const NotificationBell: React.FC = () => {
  const [items, setItems] = useState<NotifItem[]>([]);
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(() => Number(localStorage.getItem('notif_last_seen') || 0));
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; }
  })();

  const load = useCallback(async () => {
    const next: NotifItem[] = [];

    // Red-flag alerts — available to all staff.
    try {
      const r = await fetch('/api/sessions/red-flags?hours=24');
      if (r.ok) {
        const d = await r.json();
        for (const rf of (d.redFlags || [])) {
          next.push({
            id: `rf-${rf.id}`,
            kind: 'red_flag',
            sessionId: rf.session_id || null,
            title: `${String(rf.severity || 'urgent').toUpperCase()} red flag`,
            detail: formatSymptoms(rf.symptoms),
            severity: rf.severity,
            time: rf.timestamp ? new Date(rf.timestamp).getTime() : 0,
          });
        }
      }
    } catch { /* network blip — keep prior items */ }

    // Completed remote intakes — admin only (endpoint is admin-gated; skip for other roles).
    if (isAdmin) {
      try {
        const r = await fetch('/api/intake-links?page=1&limit=50');
        if (r.ok) {
          const d = await r.json();
          for (const l of (d.links || [])) {
            if (l.displayStatus === 'completed' && l.session_id) {
              next.push({
                id: `li-${l.id}`,
                kind: 'completed_intake',
                sessionId: l.session_id,
                title: 'Remote intake completed',
                detail: l.patient_name ? `${l.patient_name} finished their intake` : 'A patient finished their intake',
                time: l.completed_at ? new Date(l.completed_at).getTime() : (l.used_at ? new Date(l.used_at).getTime() : 0),
              });
            }
          }
        }
      } catch { /* ignore */ }
    }

    next.sort((a, b) => b.time - a.time);
    setItems(next.slice(0, 30));
  }, [isAdmin]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // Close on click outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (open && wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const unread = items.filter(i => i.time > lastSeen).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items.length) {
      const newest = items.reduce((m, i) => Math.max(m, i.time), lastSeen);
      setLastSeen(newest);
      localStorage.setItem('notif_last_seen', String(newest));
    }
  };

  const go = (it: NotifItem) => {
    setOpen(false);
    if (it.sessionId) navigate(`/sessions/${it.sessionId}/transcript`);
  };

  const rel = (t: number) => {
    if (!t) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  return (
    <div className="position-relative" ref={wrapRef}>
      <button
        className="btn btn-outline-secondary btn-sm rounded-circle p-2 flex-shrink-0 header-notification-btn position-relative"
        type="button"
        onClick={toggle}
        aria-label="Notifications"
        title="Notifications"
      >
        <i className="fas fa-bell"></i>
        {unread > 0 && (
          <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger" style={{ fontSize: '0.6rem' }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="shadow rounded-3 bg-white border" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 340, maxWidth: '90vw', zIndex: 1050 }}>
          <div className="d-flex justify-content-between align-items-center px-3 py-2 border-bottom">
            <span className="fw-semibold">Notifications</span>
            <span className="text-muted small">{items.length} recent</span>
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div className="text-center text-muted py-4">
                <i className="fas fa-circle-check fa-lg mb-2 d-block opacity-50"></i>
                You're all caught up
              </div>
            ) : items.map(it => (
              <button
                key={it.id}
                className="d-flex gap-2 w-100 text-start px-3 py-2 border-0 bg-white"
                style={{ borderBottom: '1px solid #f1f5f9', cursor: it.sessionId ? 'pointer' : 'default' }}
                onClick={() => go(it)}
              >
                <div style={{ width: 24, textAlign: 'center', paddingTop: 2 }}>
                  {it.kind === 'red_flag'
                    ? <i className={`fas fa-triangle-exclamation ${it.severity === 'critical' ? 'text-danger' : it.severity === 'high' ? 'text-warning' : 'text-secondary'}`}></i>
                    : <i className="fas fa-circle-check text-success"></i>}
                </div>
                <div className="flex-grow-1 overflow-hidden">
                  <div className="small fw-semibold">{it.title}</div>
                  <div className="small text-muted text-truncate">{it.detail}</div>
                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>{rel(it.time)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
