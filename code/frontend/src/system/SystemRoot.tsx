import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Flower2, Loader2, LogOut, Star, UserRound, Workflow, X } from 'lucide-react';
import App from '../App';
import { configureApi, locationFor, systemApi } from '../types';
import {
  SystemContext,
  useSystem,
  useSettingsDraft,
  type Draft,
  type Preferences,
  type Section,
  type User,
  type Workspace,
} from './SystemContext';

type Session = { user: User; csrf_token: string; expires_at: number };
export const sectionLabels: Record<Section, string> = {
  appearance: '外观与布局',
  account: '个人账号',
  workspaces: '工作区管理',
  models: '模型与连接',
  users: '用户管理',
  about: '关于系统',
};

function applyTheme(prefs: Preferences) {
  const dark =
    prefs.theme === 'dark' ||
    (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = prefs.accent;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function Avatar({ user }: { user: User }) {
  const Icon = { user: UserRound, bot: Bot, flower: Flower2, star: Star }[user.avatar as 'user'];
  return (
    <span className={`user-avatar avatar-${user.avatar_color}`} aria-hidden="true">
      {Icon ? <Icon size={18} /> : user.display_name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AuthForm({
  setup,
  onSession,
  lockedUser,
  onDiscard,
}: {
  setup: boolean;
  onSession: (session: Session) => Promise<void>;
  lockedUser?: User;
  onDiscard?: () => void;
}) {
  const [username, setUsername] = useState(lockedUser?.username || '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className={lockedUser ? 'auth-lock' : 'auth-screen'}>
      <form
        className="auth-form"
        aria-label={setup ? '初始化管理员' : '登录'}
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setBusy(true);
          try {
            if (setup && password !== confirm) throw new Error('两次输入的密码不一致');
            const session = await systemApi<Session>(
              setup ? '/auth/setup' : '/auth/login',
              'POST',
              { username, password, ...(setup ? { display_name: displayName } : {}) },
            );
            if (lockedUser && session.user.id !== lockedUser.id)
              throw new Error('请使用原账号重新登录');
            await onSession(session);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
            setPassword('');
            setConfirm('');
          }
        }}
      >
        <div className="auth-brand">
          <Workflow size={26} />
          <strong>Workflow Studio</strong>
        </div>
        <h1>{setup ? '创建管理员' : lockedUser ? '会话已过期' : '登录'}</h1>
        {lockedUser && (
          <p className="muted">{lockedUser.display_name}，重新登录以继续处理当前草稿。</p>
        )}
        <label className="field">
          用户名
          <input
            required
            autoComplete="username"
            aria-label="用户名"
            pattern="[A-Za-z0-9_.-]{3,40}"
            value={username}
            readOnly={!!lockedUser}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {setup && (
          <label className="field">
            显示名称
            <input
              required
              aria-label="显示名称"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          {setup ? '密码（至少 12 位）' : '密码'}
          <input
            required
            type="password"
            aria-label="密码"
            minLength={setup ? 12 : 1}
            maxLength={1024}
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && (
          <label className="field">
            确认密码
            <input
              required
              type="password"
              aria-label="确认密码"
              minLength={12}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy && <Loader2 className="spin" size={16} />}
          {setup ? '创建并进入工作台' : '登录'}
        </button>
        {lockedUser && (
          <button type="button" className="text-button" onClick={onDiscard}>
            放弃草稿并切换账号
          </button>
        )}
      </form>
    </div>
  );
}

export function PasswordForm({ forced = false, onDone }: { forced?: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (next.length < 12) throw new Error('新密码至少 12 位');
      if (next !== confirm) throw new Error('两次输入的密码不一致');
      await systemApi('/auth/password', 'POST', { current_password: current, new_password: next });
      onDone();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(!!(current || next || confirm), save, () => {
    setCurrent('');
    setNext('');
    setConfirm('');
  });
  return (
    <form
      className="settings-form password-form"
      aria-label="修改密码"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>{forced ? '修改临时密码' : '修改密码'}</h2>
      <label className="field">
        当前密码
        <input
          required
          type="password"
          autoComplete="current-password"
          aria-label="当前密码"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label className="field">
        新密码
        <input
          required
          type="password"
          autoComplete="new-password"
          aria-label="新密码"
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label className="field">
        确认新密码
        <input
          required
          type="password"
          autoComplete="new-password"
          aria-label="确认新密码"
          minLength={12}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        修改密码并重新登录
      </button>
    </form>
  );
}

export default function SystemRoot() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [section, setSection] = useState<Section>(() => {
    const value = new URLSearchParams(location.search).get('settings') as Section;
    return sectionLabels[value] ? value : 'appearance';
  });
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const drafts = useRef(new Map<symbol, () => Draft>());
  const registerDraft = useCallback((read: () => Draft) => {
    const id = Symbol();
    drafts.current.set(id, read);
    return () => {
      drafts.current.delete(id);
    };
  }, []);
  const guardSettings = useCallback((action: () => void) => {
    if ([...drafts.current.values()].some((read) => read().dirty)) setPending(() => action);
    else action();
  }, []);
  const dirtyDrafts = () =>
    [...drafts.current.values()].map((read) => read()).filter((d) => d.dirty);
  const installSession = async (value: Session) => {
    configureApi(workspaceId, value.user.id, value.csrf_token);
    if (!value.user.must_change_password) {
      const list = await systemApi<Workspace[]>('/workspaces');
      setWorkspaces(list);
      const params = new URLSearchParams(location.search);
      const requested =
        params.get('workspace') ||
        (params.has('run') || params.has('workflow') ? 'ws_legacy' : null);
      const chosen =
        workspaceId ||
        requested ||
        value.user.preferences.default_workspace_id ||
        list.find((w) => !w.archived_at)?.id;
      if (!chosen || !list.some((w) => w.id === chosen))
        throw new Error('工作区不存在或当前账号无权访问');
      configureApi(chosen, value.user.id, value.csrf_token);
      setWorkspaceId(chosen);
      history.replaceState(null, '', locationFor(location.search));
    }
    setSession(value);
    setLocked(false);
    applyTheme(value.user.preferences);
    window.dispatchEvent(new Event('session-restored'));
  };
  const boot = async () => {
    setError('');
    try {
      const status = await systemApi<{ initialized: boolean }>('/auth/status');
      setInitialized(status.initialized);
      if (status.initialized) {
        try {
          const value = await systemApi<Session>('/auth/me');
          await installSession(value);
        } catch (err) {
          if ((err as Error).message !== '请登录') setError((err as Error).message);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    const expire = () => {
      if (session) setLocked(true);
    };
    window.addEventListener('session-expired', expire);
    const signedOut = () => {
      configureApi('', '', '');
      setSession(null);
      setWorkspaceId('');
      setLocked(false);
      history.replaceState(null, '', location.pathname);
    };
    window.addEventListener('signed-out', signedOut);
    return () => {
      window.removeEventListener('session-expired', expire);
      window.removeEventListener('signed-out', signedOut);
    };
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => setLocked(true),
      Math.max(0, session.expires_at * 1000 - Date.now()),
    );
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(session.user.preferences);
    media.addEventListener('change', update);
    update();
    return () => {
      clearTimeout(timer);
      media.removeEventListener('change', update);
    };
  }, [session]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyDrafts().length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const refresh = async () => {
    const value = await systemApi<Session>('/auth/me');
    setSession(value);
    setWorkspaces(await systemApi('/workspaces'));
    configureApi(workspaceId, value.user.id, value.csrf_token);
  };
  const logout = async () => {
    try {
      await systemApi('/auth/logout', 'POST');
    } catch (err) {
      if ((err as Error & { status?: number }).status !== 401) {
        setError((err as Error).message);
        setLocked(true);
        return;
      }
    }
    configureApi('', '', '');
    setSession(null);
    setWorkspaceId('');
    setWorkspaces([]);
    setLocked(false);
    setError('');
    history.replaceState(null, '', location.pathname);
    applyTheme({ theme: 'system', accent: 'teal', default_workspace_id: null });
  };
  if (initialized === null)
    return (
      <div className="auth-screen">
        <Workflow size={32} />
        <p role="status">{error || '正在连接工作台…'}</p>
        {error && <button onClick={() => void boot()}>重试</button>}
      </div>
    );
  if (!session)
    return (
      <>
        {error && (
          <div className="auth-banner" role="alert">
            {error}
            <button
              onClick={() => {
                history.replaceState(null, '', location.pathname);
                setWorkspaceId('');
                setError('');
              }}
            >
              返回登录
            </button>
          </div>
        )}
        <AuthForm
          setup={!initialized}
          onSession={async (value) => {
            await installSession(value);
            setInitialized(true);
          }}
        />
      </>
    );
  if (session.user.must_change_password)
    return (
      <div className="auth-screen">
        <PasswordForm
          forced
          onDone={() => {
            configureApi('', '', '');
            setSession(null);
          }}
        />
      </div>
    );
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return <div role="alert">{error || '正在加载工作区…'}</div>;
  const savePreferences = async (prefs: Preferences) => {
    const previous = session.user.preferences;
    applyTheme(prefs);
    try {
      const saved = await systemApi<Preferences>('/me/preferences', 'PUT', prefs);
      setSession((s) => s && { ...s, user: { ...s.user, preferences: saved } });
    } catch (err) {
      applyTheme(previous);
      throw err;
    }
  };
  return (
    <SystemContext.Provider
      value={{
        user: session.user,
        workspace,
        workspaces,
        section,
        setSection,
        refresh,
        guardSettings,
        registerDraft,
        logout,
        savePreferences,
        switchWorkspace: (id) => {
          const next = workspaces.find((w) => w.id === id);
          if (!next) return;
          configureApi(id, session.user.id, session.csrf_token);
          setWorkspaceId(id);
          history.replaceState(null, '', locationFor(''));
          setError('');
        },
      }}
    >
      <div
        {...({ inert: locked ? '' : undefined } as Record<string, string | undefined>)}
        aria-hidden={locked || undefined}
      >
        <App key={`${session.user.id}:${workspaceId}`} />
      </div>
      {locked && (
        <AuthForm
          lockedUser={session.user}
          setup={false}
          onSession={installSession}
          onDiscard={() => {
            if (window.confirm('放弃未保存的草稿并切换账号？'))
              void logout().catch(() => {
                configureApi('', '', '');
                setSession(null);
                setWorkspaceId('');
                history.replaceState(null, '', location.pathname);
              });
          }}
        />
      )}
      {pending && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="dialog" aria-label="未保存的设置">
            <div className="modal-header">
              <h2>设置有未保存的修改</h2>
            </div>
            <div className="modal-footer">
              <button className="secondary" disabled={saving} onClick={() => setPending(null)}>
                取消
              </button>
              <button
                className="secondary"
                disabled={saving}
                onClick={() => {
                  dirtyDrafts().forEach((d) => d.discard());
                  const action = pending;
                  setPending(null);
                  action();
                }}
              >
                放弃修改
              </button>
              <button
                className="primary"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    for (const draft of dirtyDrafts()) if (!(await draft.save())) return;
                    const action = pending;
                    setPending(null);
                    action();
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                保存并继续
              </button>
            </div>
          </div>
        </div>
      )}
    </SystemContext.Provider>
  );
}

export function WorkspaceSwitcher({
  guard,
  onManage,
}: {
  guard: (action: () => void) => void;
  onManage: () => void;
}) {
  const system = useSystem();
  return (
    <div className="workspace-switcher">
      <select
        aria-label="切换工作区"
        value={system.workspace.id}
        onChange={(e) => guard(() => system.switchWorkspace(e.target.value))}
      >
        {system.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
            {w.archived_at ? '（已归档）' : ''}
          </option>
        ))}
      </select>
      <button className="icon-button" title="管理工作区" onClick={() => guard(onManage)}>
        <Workflow size={15} />
      </button>
    </div>
  );
}

export function AccountMenu({
  guard,
  onAccount,
}: {
  guard: (action: () => void) => void;
  onAccount: () => void;
}) {
  const system = useSystem();
  const [open, setOpen] = useState(false);
  return (
    <div className="account-menu">
      <button
        className="icon-button account-toggle"
        title={system.user.display_name}
        aria-label="账号菜单"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar user={system.user} />
      </button>
      {open && (
        <>
          <button
            className="menu-dismiss"
            aria-label="关闭账号菜单"
            onClick={() => setOpen(false)}
          />
          <div className="account-popover" role="menu">
            <strong>{system.user.display_name}</strong>
            <span className="muted">@{system.user.username}</span>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                guard(onAccount);
              }}
            >
              <UserRound size={16} />
              个人账号
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                guard(() => {
                  void system.logout();
                });
              }}
            >
              <LogOut size={16} />
              退出登录
            </button>
            <button
              className="icon-button popover-close"
              title="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
