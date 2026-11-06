import { createContext, useContext, useEffect, useRef } from 'react';

export type Preferences = {
  theme: 'light' | 'dark' | 'system';
  accent: 'teal' | 'blue' | 'rose' | 'amber';
  default_workspace_id: string | null;
};
export type User = {
  id: string;
  username: string;
  display_name: string;
  email: string;
  avatar: string;
  avatar_color: string;
  is_admin: boolean;
  disabled: boolean;
  must_change_password: boolean;
  revision: number;
  preferences: Preferences;
};
export type Workspace = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  template: string;
  archived_at: string | null;
  revision: number;
};
export type Section = 'appearance' | 'account' | 'workspaces' | 'models' | 'users' | 'about';
export type Draft = { dirty: boolean; save: () => Promise<boolean>; discard: () => void };
export const SystemContext = createContext<{
  user: User;
  workspace: Workspace;
  workspaces: Workspace[];
  section: Section;
  setSection: (section: Section) => void;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  logout: () => Promise<void>;
  savePreferences: (prefs: Preferences) => Promise<void>;
  guardSettings: (action: () => void) => void;
  registerDraft: (read: () => Draft) => () => void;
} | null>(null);

export function useSystem() {
  const context = useContext(SystemContext);
  if (!context) throw new Error('System context unavailable');
  return context;
}

export function useSettingsDraft(dirty: boolean, save: Draft['save'], discard: Draft['discard']) {
  const registerDraft = useContext(SystemContext)?.registerDraft;
  const ref = useRef<Draft>({ dirty, save, discard });
  ref.current = { dirty, save, discard };
  useEffect(() => registerDraft?.(() => ref.current), [registerDraft]);
}
