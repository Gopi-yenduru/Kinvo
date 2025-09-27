interface AuthState {
  token: string | null;
  user: string | null;
  userName: string | null;
}

class AuthService {
  private listeners: Set<(authState: AuthState) => void> = new Set();

  // Get current auth state
  getAuthState(): AuthState {
    return {
      token: localStorage.getItem('jwt_token'),
      user: localStorage.getItem('user'),
      userName: localStorage.getItem('user_name')
    };
  }

  // Set authentication data
  setAuth(token: string, user: string, userName: string): void {
    localStorage.setItem('jwt_token', token);
    localStorage.setItem('user', user);
    localStorage.setItem('user_name', userName);

    // Notify listeners
    this.notifyListeners();
  }

  // Clear authentication data
  clearAuth(): void {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('user');
    localStorage.removeItem('user_name');

    // Notify listeners
    this.notifyListeners();
  }

  // Check if user is authenticated (basic token format check)
  isAuthenticated(): boolean {
    const { token } = this.getAuthState();
    return !!(token && token.trim() && token.split('.').length === 3);
  }

  // Subscribe to auth state changes
  subscribe(listener: (authState: AuthState) => void): () => void {
    this.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Notify all listeners of auth state changes
  private notifyListeners(): void {
    const authState = this.getAuthState();
    this.listeners.forEach(listener => listener(authState));
  }
}

// Create singleton instance
export const authService = new AuthService();
export default authService;