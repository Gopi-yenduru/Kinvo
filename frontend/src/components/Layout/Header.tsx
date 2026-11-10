import React, {useState, useEffect} from 'react';
import { useLocation } from 'react-router-dom';
import UserMenu from './UserMenu';

// Breadcrumb title for the current route (the header used to say "Dashboard" on every page).
const PAGE_TITLES: { prefix: string; title: string }[] = [
  { prefix: '/sessions/', title: 'Transcript' },
  { prefix: '/sessions', title: 'Sessions' },
  { prefix: '/session', title: 'New Session' },
  { prefix: '/patients', title: 'Patients' },
  { prefix: '/analytics', title: 'Analytics' },
  { prefix: '/intake-links', title: 'Intake Links' },
  { prefix: '/users', title: 'Users' },
  { prefix: '/settings', title: 'Settings' },
];
const pageTitle = (path: string) => PAGE_TITLES.find(p => path.startsWith(p.prefix))?.title || 'Dashboard';
import NotificationBell from './NotificationBell';

interface HeaderProps {
  onToggleSidebar?: () => void;
  onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ onToggleSidebar, onLogout }) => {
  const [userName, setUserName] = useState<string | null>(null);
  const { pathname } = useLocation();
  // Load user from localStorage or token
  useEffect(() => {
    const storedName = localStorage.getItem('user_name') || 'User';
    if (storedName) setUserName(storedName);
  }, []);


  return (
    <header className="medical-header w-100">
      <div className="container-fluid px-3 px-md-4">
        <div className="row align-items-center g-2 g-md-3">
          {/* Mobile menu button and breadcrumb */}
          <div className="col-12 col-lg-3">
            <div className="d-flex align-items-center gap-2 gap-md-3">
              {/* Mobile menu toggle - only visible on small screens */}
              <button
                className="btn btn-outline-primary d-lg-none p-2 flex-shrink-0 mobile-menu-btn"
                onClick={onToggleSidebar}
                aria-label="Open menu"
              >
                <i className="fas fa-bars"></i>
              </button>
              
              {/* Breadcrumb - responsive */}
              <nav aria-label="breadcrumb" className="flex-grow-1">
                <ol className="breadcrumb mb-0 small">
                  <li className="breadcrumb-item d-none d-sm-inline">
                    <span className="text-muted">Kinvo</span>
                  </li>
                  <li className="breadcrumb-item active" aria-current="page">
                    <span className="fw-semibold">{pageTitle(pathname)}</span>
                  </li>
                </ol>
              </nav>
            </div>
          </div>

          {/* Search bar - responsive */}
          <div className="col-12 col-lg-6 order-3 order-lg-2">
            <div className="position-relative w-100">
              <div className="position-absolute top-50 start-0 translate-middle-y ms-3 z-1">
                <i className="fas fa-search text-muted"></i>
              </div>
              <input
                type="text"
                placeholder="Search sessions, patients..."
                className="form-control ps-5 pe-4 w-100 header-search-input"
                aria-label="Search sessions and patients"
              />
              <div className="position-absolute top-50 end-0 translate-middle-y me-3 d-none d-xl-block">
                <kbd className="kbd">⌘K</kbd>
              </div>
            </div>
          </div>

          {/* User actions - responsive */}
          <div className="col-12 col-lg-3 order-2 order-lg-3">
            <div className="d-flex align-items-center justify-content-end gap-2">
              {/* Notifications — red-flag alerts + completed remote intakes */}
              <NotificationBell />

              {/* User menu */}
              <UserMenu userName={userName} onLogout={onLogout} status="online" />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;