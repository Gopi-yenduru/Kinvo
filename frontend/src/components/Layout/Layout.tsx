import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import HelpBot from '../HelpBot/HelpBot';

interface LayoutProps {
  onLogout: () => void;
}

const Layout: React.FC<LayoutProps> = ({ onLogout }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Check screen size and set mobile state
  useEffect(() => {
    const checkScreenSize = () => {
      const mobile = window.innerWidth < 992; // Bootstrap lg breakpoint
      setIsMobile(mobile);
      if (mobile) {
        setSidebarCollapsed(true); // Auto-collapse on mobile
      }
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  return (
    <div className="d-flex min-vh-100 position-relative">
      {/* Mobile overlay when sidebar is open */}
      {isMobile && !sidebarCollapsed && (
        <div
          className="position-fixed top-0 start-0 w-100 h-100 bg-dark bg-opacity-50 mobile-overlay"
          onClick={toggleSidebar}
        />
      )}
      
      {/* Sidebar */}
      <div
        className={`sidebar-container ${isMobile ? 'sidebar-mobile' : ''} ${
          sidebarCollapsed ? 'sidebar-collapsed' : ''
        }`}
      >
        <Sidebar isCollapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      </div>
      
      {/* Main content area */}
      <div
        className={`main-content-area ${isMobile ? 'main-mobile' : ''} ${
          sidebarCollapsed ? 'main-sidebar-collapsed' : ''
        }`}
      >
        {/* Pass onLogout to Header */}
        <Header onToggleSidebar={toggleSidebar} onLogout={onLogout} />
        <main className="flex-grow-1 bg-light overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* Multilingual help assistant (English / Hindi / Telugu) — floating, on every screen */}
      <HelpBot />
    </div>
  );
};

export default Layout;
