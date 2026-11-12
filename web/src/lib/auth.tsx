import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from './api.ts';
import { unregisterDevice } from './device.ts';
import { clearOfflineData } from './offline.ts';
import type { Action, Role } from '../../../shared/domain.ts';

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  must_change_password: number;
  two_factor: boolean;
  project_ids: number[];
  permissions: Action[];
}

interface SessionData {
  user: User | null;
  demoMode: boolean;
  whatsappLive: boolean;
  telephonyLive: boolean;
  aiEnabled: boolean;
  mustSetupTwoFactor: boolean;
}

interface Session extends SessionData {
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (action: Action) => boolean;
}

const Ctx = createContext<Session>(null as unknown as Session);
export const useAuth = () => useContext(Ctx);

const EMPTY: SessionData = { user: null, demoMode: false, whatsappLive: false, telephonyLive: false, aiEnabled: false, mustSetupTwoFactor: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ ...EMPTY, loading: true });

  const refresh = async () => {
    try {
      const data = await api.get('/auth/me');
      setState({ ...data, loading: false });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState((s) => ({ ...s, user: null, loading: false }));
      else setState((s) => ({ ...s, loading: false }));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const logout = async () => {
    await unregisterDevice(); // Alerts must not follow a shared phone to the next person.
    await api.post('/auth/logout');
    await clearOfflineData(); // Customer data must not stay on a shared device.
    setState((s) => ({ ...s, user: null }));
  };

  const can = (action: Action) => Boolean(state.user?.permissions?.includes(action));
  return <Ctx.Provider value={{ ...state, refresh, logout, can }}>{children}</Ctx.Provider>;
}
