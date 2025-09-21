import React from 'react';

interface UserMenuProps {
   userName: string | null;
  onLogout: () => void;
  status?: 'online' | 'offline';
}

const UserMenu: React.FC<UserMenuProps> = ({ userName, onLogout, status = 'online' }) => {
  const statusColor = status === 'online' ? 'text-success' : 'text-secondary';

  return (
    <div className="user-menu d-flex align-items-center gap-2 p-2 rounded-3 border flex-shrink-0">
      {/* Avatar */}
      <div className="user-avatar bg-primary text-white rounded-circle d-flex align-items-center justify-content-center header-user-avatar" style={{ width: '40px', height: '40px', fontSize: '1.2rem' }}>
        👨‍⚕️
      </div>

      {/* User Info */}
      <div className="user-info d-none d-xl-block">
        <div className="user-name fw-semibold small">Dr. {userName ?? 'User'}</div>
        <div className={`user-status small d-flex align-items-center ${statusColor}`}>
          <i className="fas fa-circle me-1" style={{ fontSize: '0.5rem' }}></i>
          {status === 'online' ? 'Online' : 'Offline'}
        </div>
      </div>

      {/* Logout Button */}
      <button
        className="btn btn-sm btn-outline-danger ms-auto"
        onClick={onLogout}
        title="Logout"
      >
        Logout
      </button>
    </div>
  );
};

export default UserMenu;
