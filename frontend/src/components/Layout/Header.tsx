import React, { useState } from 'react';

const Header: React.FC = () => {
  const [notifications] = useState([
    { id: 1, type: 'alert', message: 'Red flag detected in Session #1234', time: '2 min ago' },
    { id: 2, type: 'info', message: 'New session completed successfully', time: '5 min ago' },
    { id: 3, type: 'warning', message: 'System maintenance scheduled', time: '1 hour ago' }
  ]);

  const [showNotifications, setShowNotifications] = useState(false);

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="breadcrumb">
          <span className="breadcrumb-item">Medical Intake</span>
          <span className="breadcrumb-separator">/</span>
          <span className="breadcrumb-item current">Dashboard</span>
        </div>
      </div>

      <div className="header-center">
        <div className="search-bar">
          <div className="search-icon">🔍</div>
          <input 
            type="text" 
            placeholder="Search sessions, patients, or transcripts..." 
            className="search-input"
          />
        </div>
      </div>

      <div className="header-right">
        <div className="header-actions">
          
          <div className="notifications-wrapper">
            <button 
              className="action-btn notifications-btn"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <span className="action-icon">🔔</span>
              {notifications.length > 0 && (
                <span className="notification-badge">{notifications.length}</span>
              )}
            </button>
            
            {showNotifications && (
              <div className="notifications-dropdown">
                <div className="notifications-header">
                  <h3>Notifications</h3>
                  <button className="mark-all-read">Mark all read</button>
                </div>
                <div className="notifications-list">
                  {notifications.map((notification) => (
                    <div key={notification.id} className={`notification-item ${notification.type}`}>
                      <div className="notification-content">
                        <p>{notification.message}</p>
                        <span className="notification-time">{notification.time}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="user-menu">
            <div className="user-avatar">👨‍⚕️</div>
            <div className="user-info">
              <span className="user-name">Dr. Smith</span>
              <span className="user-status online">Online</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;