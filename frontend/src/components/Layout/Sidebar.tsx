import React from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../../contexts/SessionContext';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isCollapsed, onToggle }) => {
  const { hasActiveSession, currentSessionProvider } = useSession();

  const menuItems = [
    {
      path: '/',
      icon: 'fas fa-home',
      label: 'Dashboard',
      description: 'Overview & Analytics'
    },
    {
      path: '/session',
      icon: 'fas fa-microphone',
      label: 'New Session',
      description: 'Start Voice Intake'
    },
    {
      path: '/sessions',
      icon: 'fas fa-list',
      label: 'Sessions',
      description: 'View All Sessions'
    },
    {
      path: '/analytics',
      icon: 'fas fa-chart-bar',
      label: 'Analytics',
      description: 'Reports & Insights'
    },
    {
      path: '/settings',
      icon: 'fas fa-cog',
      label: 'Settings',
      description: 'System Configuration'
    }
  ];

  const handleNavClick = (e: React.MouseEvent, path: string) => {
    if (hasActiveSession && path !== '/session') {
      e.preventDefault();
      alert('Please end your current medical session before navigating to other pages.');
      return false;
    }
  };

  return (
    <aside className={`medical-sidebar ${isCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Header */}
      <div className="sidebar-header">
        <div className="d-flex align-items-center justify-content-between">
          <div className="d-flex align-items-center gap-2">
            <div className="sidebar-logo-icon">
              <i className="fas fa-hospital text-white"></i>
            </div>
            {!isCollapsed && (
              <div className="sidebar-logo-text">
                <h5 className="mb-0 fw-bold text-white">MedIntake</h5>
                <small className="text-white text-opacity-75">AI Voice Assistant</small>
              </div>
            )}
          </div>
          <button
            className="sidebar-toggle-btn"
            onClick={onToggle}
          >
            <i className={`fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-left'}`}></i>
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        <ul className="list-unstyled mb-0">
          {menuItems.map((item) => (
            <li key={item.path} className="sidebar-nav-item">
              {hasActiveSession ? (
                // Disable navigation during active session (except for session page)
                item.path === '/session' ? (
                  <NavLink
                    to={item.path}
                    className={({ isActive }) =>
                      `sidebar-nav-link ${isActive ? 'active' : ''}`
                    }
                    onClick={(e) => handleNavClick(e, item.path)}
                  >
                    <div className="d-flex align-items-center gap-3 w-100">
                      <i className={`${item.icon} sidebar-nav-icon session-active ${isCollapsed ? 'fa-lg' : ''}`}></i>
                      {!isCollapsed && (
                        <div className="sidebar-nav-content">
                          <div className="sidebar-nav-label">{item.label}</div>
                          <div className="sidebar-nav-description">
                            Active Session
                          </div>
                        </div>
                      )}
                    </div>
                  </NavLink>
                ) : (
                  // Disabled nav item with tooltip
                  <a
                    href="#"
                    className="sidebar-nav-link disabled"
                    title="Please end your current medical session to access navigation"
                    onClick={() => alert('Please end your current medical session before navigating to other pages.')}
                  >
                    <div className="d-flex align-items-center gap-3 w-100">
                      <i className={`${item.icon} sidebar-nav-icon disabled-nav ${isCollapsed ? 'fa-lg' : ''}`}></i>
                      {!isCollapsed && (
                        <div className="sidebar-nav-content">
                          <div className="sidebar-nav-label text-muted">{item.label}</div>
                          <div className="sidebar-nav-description text-muted small">
                            Session in progress...
                          </div>
                        </div>
                      )}
                    </div>
                  </a>
                )
              ) : (
                // Normal navigation when no active session
                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    `sidebar-nav-link ${isActive ? 'active' : ''}`
                  }
                  onClick={(e) => handleNavClick(e, item.path)}
                >
                  <div className="d-flex align-items-center gap-3 w-100">
                    <i className={`${item.icon} sidebar-nav-icon ${isCollapsed ? 'fa-lg' : ''}`}></i>
                    {!isCollapsed && (
                      <div className="sidebar-nav-content">
                        <div className="sidebar-nav-label">{item.label}</div>
                        <div className="sidebar-nav-description">
                          {item.description}
                        </div>
                      </div>
                    )}
                  </div>
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        {hasActiveSession && (
          <div className="d-flex align-items-center gap-2 p-2 bg-primary bg-opacity-10 text-primary border-top border-primary border-opacity-25">
            <i className="fas fa-circle text-success" style={{ fontSize: '8px' }}></i>
            {!isCollapsed && (
              <span className="fw-semibold small">
                Session Active
                {currentSessionProvider && (
                  <span className="text-muted ms-1">
                    ({currentSessionProvider})
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
