import React from 'react';
import { NavLink } from 'react-router-dom';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isCollapsed, onToggle }) => {
  const menuItems = [
    {
      path: '/',
      icon: '🏠',
      label: 'Dashboard',
      description: 'Overview & Analytics'
    },
    {
      path: '/session',
      icon: '🎙️',
      label: 'New Session',
      description: 'Start Voice Intake'
    },
    {
      path: '/sessions',
      icon: '📋',
      label: 'Sessions',
      description: 'View All Sessions'
    },
    {
      path: '/analytics',
      icon: '📊',
      label: 'Analytics',
      description: 'Reports & Insights'
    },
    {
      path: '/settings',
      icon: '⚙️',
      label: 'Settings',
      description: 'System Configuration'
    }
  ];

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">🏥</div>
          {!isCollapsed && (
            <div className="logo-text">
              <h2>MedIntake</h2>
              <span>AI Voice Assistant</span>
            </div>
          )}
        </div>
        <button className="sidebar-toggle" onClick={onToggle}>
          {isCollapsed ? '→' : '←'}
        </button>
      </div>

      <nav className="sidebar-nav">
        <ul className="nav-list">
          {menuItems.map((item) => (
            <li key={item.path} className="nav-item">
              <NavLink
                to={item.path}
                className={({ isActive }) => 
                  `nav-link ${isActive ? 'active' : ''}`
                }
              >
                <div className="nav-icon">{item.icon}</div>
                {!isCollapsed && (
                  <div className="nav-content">
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-description">{item.description}</span>
                  </div>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        {!isCollapsed && (
          <div className="user-profile">
            <div className="user-avatar">👨‍⚕️</div>
            <div className="user-info">
              <span className="user-name">Dr. Smith</span>
              <span className="user-role">Medical Professional</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;