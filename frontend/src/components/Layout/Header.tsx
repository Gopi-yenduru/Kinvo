import React from 'react';

const Header: React.FC = () => {

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