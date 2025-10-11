import React, { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface SessionContextType {
  hasActiveSession: boolean;
  currentSessionProvider?: string;
  sessionStartTime?: Date;
  startSession: (provider?: string) => void;
  endSession: () => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export const SessionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [currentSessionProvider, setCurrentSessionProvider] = useState<string | undefined>();
  const [sessionStartTime, setSessionStartTime] = useState<Date | undefined>();

  const startSession = useCallback((provider?: string) => {
    setHasActiveSession(true);
    setCurrentSessionProvider(provider);
    setSessionStartTime(new Date());
  }, []);

  const endSession = useCallback(() => {
    setHasActiveSession(false);
    setCurrentSessionProvider(undefined);
    setSessionStartTime(undefined);
  }, []);

  return (
    <SessionContext.Provider
      value={{
        hasActiveSession,
        currentSessionProvider,
        sessionStartTime,
        startSession,
        endSession
      }}
    >
      {children}
    </SessionContext.Provider>
  );
};

export const useSession = () => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
};
