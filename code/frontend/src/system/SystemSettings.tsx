import { useEffect, useState, type ReactNode } from 'react';
import {
  Archive,
  Bot,
  Check,
  CircleHelp,
  KeyRound,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Shield,
  Sun,
  UserRound,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { api, systemApi } from '../types';
import { WorkspaceSettings } from '../settings/WorkspaceSettings';
import { Avatar, PasswordForm, sectionLabels } from './SystemRoot';
import {
  useSettingsDraft,
  useSystem,
  type Section,
  type User,
  type Workspace,
} from './SystemContext';

const accents = [
  ['teal', '青绿'],
  ['blue', '蓝'],
  ['rose', '玫红'],
  ['amber', '琥珀'],
] as const;
const icons = {
  appearance: Palette,
  account: UserRound,
  workspaces: Workflow,
  models: Bot,
  users: Users,
  about: CircleHelp,
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Feedback({ text, error = false }: { text: string; error?: boolean }) {
  return text ? (
    <p role={error ? 'alert' : 'status'} className={error ? 'form-error' : 'settings-feedback'}>
      {text}
    </p>
  ) : null;
}

export function SystemSettings({ onSaved }: { onSaved: () => void }) {
  const system = useSystem();
  const sections = (Object.keys(sectionLabels) as Section[]).filter(
    (s) => s !== 'users' || system.user.is_admin,
  );
  const select = (section: Section) => system.guardSettings(() => system.setSection(section));
  return (
    <section className="system-settings" aria-label="系统设置">
      <div className="system-settings-heading">
        <Settings2 size={21} />
        <h1>系统设置</h1>
      </div>
      <select
        className="settings-mobile-nav"
        aria-label="设置分类"
        value={system.section}
        onChange={(e) => select(e.target.value as Section)}
      >
        {sections.map((s) => (
          <option value={s} key={s}>
            {sectionLabels[s]}
          </option>
        ))}
      </select>
      <div className="system-settings-layout">
        <nav className="system-settings-nav" aria-label="设置分类">
          {sections.map((s) => {
            const Icon = icons[s];
            return (
              <button
                key={s}
                className={system.section === s ? 'active' : ''}
                aria-current={system.section === s ? 'page' : undefined}
                onClick={() => select(s)}
              >
                <Icon size={17} />
                {sectionLabels[s]}
              </button>
            );
          })}
        </nav>
        <div className="system-settings-content" key={system.section}>
          {system.section === 'appearance' ? (
            <Appearance />
          ) : system.section === 'account' ? (
            <Account />
          ) : system.section === 'workspaces' ? (
            <Workspaces />
          ) : system.section === 'users' && system.user.is_admin ? (
            <UserManagement />
          ) : system.section === 'models' ? (
            <>
              <div className="settings-page-title">
                <h2>模型与连接</h2>
                <span className="tag">{system.workspace.name}</span>
                {system.workspace.archived_at && <span className="tag amber">已归档 · 只读</span>}
              </div>
              <WorkspaceSettings onSaved={onSaved} />
            </>
          ) : (
            <About />
          )}
        </div>
      </div>
    </section>
  );
}

function Appearance() {
  const system = useSystem();
  const prefs = system.user.preferences;
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = async (patch: Partial<typeof prefs>) => {
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      await system.savePreferences({ ...prefs, ...patch });
      setFeedback('外观已保存');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-page">
      <h2>外观与布局</h2>
      <section className="settings-band">
        <h3>主题</h3>
        <div className="theme-options" role="group" aria-label="主题模式">
          {[
            ['light', '浅色', Sun],
            ['dark', '深色', Moon],
            ['system', '跟随系统', Monitor],
          ].map(([id, label, Icon]) => {
            const Symbol = Icon as typeof Sun;
            return (
              <button
                key={String(id)}
                className={`theme-option theme-preview-${id} ${prefs.theme === id ? 'selected' : ''}`}
                aria-pressed={prefs.theme === id}
                disabled={busy}
                onClick={() => void change({ theme: id as typeof prefs.theme })}
              >
                <span className="theme-preview" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <Symbol size={16} />
                  {String(label)}
                  {prefs.theme === id && <Check size={14} />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-band">
        <h3>强调色</h3>
        <div className="accent-options" role="group" aria-label="强调色">
          {accents.map(([id, label]) => (
            <button
              key={id}
              className={`accent-swatch accent-${id}`}
              title={label}
              aria-label={`强调色：${label}`}
              aria-pressed={prefs.accent === id}
              disabled={busy}
              onClick={() => void change({ accent: id })}
            >
              {prefs.accent === id && <Check size={18} />}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-band">
        <h3>面板布局</h3>
        <button
          className="secondary"
          onClick={() => {
            const prefix = `workflow-panel:${system.user.id}:`;
            for (let index = localStorage.length - 1; index >= 0; index--) {
              const key = localStorage.key(index);
              if (key?.startsWith(prefix)) localStorage.removeItem(key);
            }
            window.dispatchEvent(new Event('reset-panel-layout'));
            setFeedback('面板尺寸已恢复默认');
          }}
        >
          <RotateCcw size={15} />
          恢复默认面板尺寸
        </button>
      </section>
      <Feedback text={feedback} />
      <Feedback text={error} error />
    </div>
  );
}

type Profile = Pick<User, 'username' | 'display_name' | 'email' | 'avatar' | 'avatar_color'>;
const profileOf = (user: User): Profile => ({
  username: user.username,
  display_name: user.display_name,
  email: user.email,
  avatar: user.avatar,
  avatar_color: user.avatar_color,
});
const emptyProfile: Profile = {
  username: '',
  display_name: '',
  email: '',
  avatar: 'initials',
  avatar_color: 'teal',
};

function ProfileFields({
  value,
  onChange,
  password,
  setPassword,
}: {
  value: Profile;
  onChange: (value: Profile) => void;
  password?: string;
  setPassword?: (value: string) => void;
}) {
  return (
    <>
      <Field label="登录用户名">
        <input
          aria-label="登录用户名"
          required
          pattern="[A-Za-z0-9_.-]{3,40}"
          value={value.username}
          onChange={(e) => onChange({ ...value, username: e.target.value })}
          autoComplete="off"
        />
      </Field>
      <Field label="显示名称">
        <input
          aria-label="显示名称"
          required
          maxLength={80}
          value={value.display_name}
          onChange={(e) => onChange({ ...value, display_name: e.target.value })}
        />
      </Field>
      <Field label="联系邮箱">
        <input
          aria-label="联系邮箱"
          type="email"
          maxLength={254}
          value={value.email}
          onChange={(e) => onChange({ ...value, email: e.target.value })}
        />
      </Field>
      <div className="profile-avatar-editor">
        <Avatar user={value as User} />
        <Field label="头像">
          <select
            aria-label="头像"
            value={value.avatar}
            onChange={(e) => onChange({ ...value, avatar: e.target.value })}
          >
            <option value="initials">姓名缩写</option>
            <option value="user">人物</option>
            <option value="bot">机器人</option>
            <option value="flower">花朵</option>
            <option value="star">星形</option>
          </select>
        </Field>
        <Field label="头像颜色">
          <select
            aria-label="头像颜色"
            value={value.avatar_color}
            onChange={(e) => onChange({ ...value, avatar_color: e.target.value })}
          >
            {accents.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {setPassword && (
        <Field label="验证当前密码">
          <input
            aria-label="验证当前密码"
            type="password"
            required
            autoComplete="current-password"
            value={password || ''}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
    </>
  );
}

function Account() {
  const system = useSystem();
  const [draft, setDraft] = useState(profileOf(system.user));
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profileOf(system.user));
  useEffect(() => {
    setDraft(profileOf(system.user));
    setPassword('');
  }, [system.user.revision]);
  const save = async () => {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await systemApi('/me', 'PATCH', {
        ...draft,
        revision: system.user.revision,
        current_password: password || null,
      });
      await system.refresh();
      setFeedback('个人资料已保存');
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(dirty, save, () => {
    setDraft(profileOf(system.user));
    setPassword('');
  });
  return (
    <div className="settings-page">
      <h2>个人账号</h2>
      <form
        className="settings-form"
        aria-label="个人资料"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          <ProfileFields
            value={draft}
            onChange={setDraft}
            {...(draft.username !== system.user.username ? { password, setPassword } : {})}
          />
          <div className="settings-form-actions">
            <button className="primary" disabled={!dirty}>
              <Save size={15} />
              保存资料
            </button>
            <span className="muted">
              {system.user.is_admin ? '管理员' : '用户'} · {system.user.id}
            </span>
          </div>
        </fieldset>
      </form>
      <Feedback text={feedback} />
      <Feedback text={error} error />
      <section className="settings-band">
        <PasswordForm onDone={() => window.dispatchEvent(new Event('signed-out'))} />
      </section>
    </div>
  );
}

function Workspaces() {
  const system = useSystem();
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    template: string;
    id?: string;
    revision?: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!draft) return true;
    setBusy(true);
    setError('');
    try {
      const { id, ...body } = draft;
      await systemApi(
        '/workspaces' + (id ? `/${id}` : ''),
        id ? 'PATCH' : 'POST',
        id ? { name: body.name, description: body.description, revision: body.revision } : body,
      );
      setDraft(null);
      await system.refresh();
      setFeedback(id ? '工作区资料已保存' : '工作区已创建');
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(!!draft, save, () => setDraft(null));
  const state = async (workspace: Workspace, action: 'archive' | 'restore') => {
    if (action === 'archive' && !window.confirm(`将“${workspace.name}”移入归档？历史记录会保留。`))
      return;
    setBusy(true);
    setError('');
    try {
      await systemApi(`/workspaces/${workspace.id}/${action}`, 'POST', {
        revision: workspace.revision,
      });
      await system.refresh();
      setFeedback(action === 'archive' ? '工作区已归档' : '工作区已恢复');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="settings-page-title">
        <h2>工作区管理</h2>
        <button
          className="primary"
          onClick={() => setDraft({ name: '', description: '', template: 'empty' })}
        >
          <Plus size={15} />
          新建工作区
        </button>
      </div>
      <div className="settings-list-tools">
        <div className="panel-segments">
          <button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>
            可用工作区
          </button>
          <button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>
            归档
          </button>
        </div>
        <input
          aria-label="搜索工作区"
          placeholder="搜索工作区"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Feedback text={feedback} />
      <Feedback text={error} error />
      <div className="settings-data-list">
        {system.workspaces
          .filter(
            (w) =>
              !!w.archived_at === archived && w.name.toLowerCase().includes(search.toLowerCase()),
          )
          .map((w) => (
            <div className="settings-data-row" key={w.id}>
              <Workflow size={19} />
              <div className="settings-row-main">
                <strong>{w.name}</strong>
                <p className="muted">{w.description || '—'}</p>
                <code>{w.id}</code>
              </div>
              <div className="settings-row-tags">
                {w.id === system.workspace.id && <span className="tag green">当前</span>}
                {w.id === system.user.preferences.default_workspace_id && (
                  <span className="tag">默认</span>
                )}
              </div>
              <div className="settings-row-actions">
                <button className="secondary" onClick={() => system.switchWorkspace(w.id)}>
                  打开
                </button>
                {!archived && (
                  <>
                    <button
                      className="icon-button"
                      title={`编辑 ${w.name}`}
                      onClick={() =>
                        setDraft({
                          id: w.id,
                          revision: w.revision,
                          name: w.name,
                          description: w.description,
                          template: w.template,
                        })
                      }
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      title={`设为默认：${w.name}`}
                      disabled={busy || w.id === system.user.preferences.default_workspace_id}
                      onClick={async () => {
                        try {
                          await system.savePreferences({
                            ...system.user.preferences,
                            default_workspace_id: w.id,
                          });
                          setFeedback('默认工作区已更新');
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      <Check size={15} />
                    </button>
                  </>
                )}
                <button
                  className="icon-button"
                  title={`${archived ? '恢复' : '归档'} ${w.name}`}
                  disabled={busy}
                  onClick={() => void state(w, archived ? 'restore' : 'archive')}
                >
                  {archived ? <RotateCcw size={15} /> : <Archive size={15} />}
                </button>
              </div>
            </div>
          ))}
        {!system.workspaces.some(
          (w) =>
            !!w.archived_at === archived && w.name.toLowerCase().includes(search.toLowerCase()),
        ) && (
          <div className="settings-empty">{archived ? '暂无归档工作区' : '没有匹配的工作区'}</div>
        )}
      </div>
      {draft && (
        <div className="modal-backdrop">
          <form
            className="modal small-modal"
            role="dialog"
            aria-label={draft.id ? '编辑工作区' : '新建工作区'}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="modal-header">
              <h2>{draft.id ? '编辑工作区' : '新建工作区'}</h2>
              <button
                className="icon-button"
                type="button"
                title="关闭工作区配置"
                onClick={() => system.guardSettings(() => setDraft(null))}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <Field label="工作区名称">
                <input
                  autoFocus
                  aria-label="工作区名称"
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="描述">
                <textarea
                  aria-label="工作区描述"
                  maxLength={1000}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
              {!draft.id && (
                <Field label="初始内容">
                  <select
                    aria-label="初始内容"
                    value={draft.template}
                    onChange={(e) => setDraft({ ...draft, template: e.target.value })}
                  >
                    <option value="empty">空白工作区</option>
                    <option value="demo">内置示例（离线模型）</option>
                  </select>
                </Field>
              )}
              <Feedback text={error} error />
            </div>
            <div className="modal-footer">
              <button className="primary" disabled={busy}>
                <Save size={15} />
                {draft.id ? '保存工作区' : '创建工作区'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function UserManagement() {
  const system = useSystem();
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<(Profile & { id?: string; revision?: number }) | null>(null);
  const [reset, setReset] = useState<User | null>(null);
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => setUsers(await systemApi('/admin/users'));
  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, []);
  const discard = () => {
    setDraft(null);
    setReset(null);
    setPassword('');
    setCurrentPassword('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (reset)
        await systemApi(`/admin/users/${reset.id}/reset-password`, 'POST', {
          revision: reset.revision,
          new_password: password,
        });
      else if (draft) {
        const { id, ...body } = draft;
        await systemApi(
          '/admin/users' + (id ? `/${id}` : ''),
          id ? 'PATCH' : 'POST',
          id ? { ...body, current_password: currentPassword || null } : { ...body, password },
        );
      }
      const selfReset = reset?.id === system.user.id;
      discard();
      setFeedback('用户资料已保存');
      if (selfReset) window.dispatchEvent(new Event('signed-out'));
      else {
        await load();
        await system.refresh();
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(!!draft || !!reset, save, discard);
  return (
    <div className="settings-page">
      <div className="settings-page-title">
        <h2>用户管理</h2>
        <button
          className="primary"
          onClick={() => {
            discard();
            setDraft({ ...emptyProfile });
            setError('');
          }}
        >
          <Plus size={15} />
          创建用户
        </button>
      </div>
      <input
        aria-label="搜索用户"
        placeholder="搜索用户名或显示名称"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Feedback text={feedback} />
      <Feedback text={error} error />
      <div className="settings-data-list">
        {users
          .filter((u) =>
            `${u.username} ${u.display_name}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map((u) => (
            <div className="settings-data-row" key={u.id}>
              <Avatar user={u} />
              <div className="settings-row-main">
                <strong>{u.display_name}</strong>
                <p className="muted">@{u.username}</p>
              </div>
              <span className="tag">
                {u.is_admin
                  ? '管理员'
                  : u.disabled
                    ? '已停用'
                    : u.must_change_password
                      ? '待修改密码'
                      : '正常'}
              </span>
              <div className="settings-row-actions">
                <button
                  className="icon-button"
                  title={`编辑用户 ${u.username}`}
                  disabled={busy}
                  onClick={() => {
                    discard();
                    setError('');
                    setDraft({ ...profileOf(u), id: u.id, revision: u.revision });
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button"
                  title={`重置密码 ${u.username}`}
                  disabled={busy}
                  onClick={() => {
                    discard();
                    setError('');
                    setReset(u);
                  }}
                >
                  <KeyRound size={15} />
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`${u.disabled ? '恢复' : '停用'}用户“${u.display_name}”？`))
                      return;
                    setBusy(true);
                    setError('');
                    try {
                      await systemApi(
                        `/admin/users/${u.id}/${u.disabled ? 'restore' : 'disable'}`,
                        'POST',
                        { revision: u.revision },
                      );
                      await load();
                      setFeedback('用户状态已更新');
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {u.disabled ? '恢复' : '停用'}
                </button>
              </div>
            </div>
          ))}
      </div>
      {(draft || reset) && (
        <div className="modal-backdrop">
          <form
            className="modal small-modal"
            role="dialog"
            aria-label={reset ? '重置用户密码' : draft?.id ? '编辑用户' : '创建用户'}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="modal-header">
              <h2>
                {reset ? `重置密码 · ${reset.username}` : draft?.id ? '编辑用户' : '创建用户'}
              </h2>
              <button
                className="icon-button"
                type="button"
                title="关闭用户配置"
                onClick={() => system.guardSettings(discard)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              {draft && (
                <ProfileFields
                  value={draft}
                  onChange={(v) => setDraft({ ...draft, ...v })}
                  {...(draft.id === system.user.id && draft.username !== system.user.username
                    ? { password: currentPassword, setPassword: setCurrentPassword }
                    : {})}
                />
              )}
              {(reset || !draft?.id) && (
                <Field label="临时密码（至少 12 位）">
                  <input
                    aria-label="临时密码"
                    type="password"
                    required
                    minLength={12}
                    maxLength={1024}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              )}
              <Feedback text={error} error />
            </div>
            <div className="modal-footer">
              <button className="primary" disabled={busy}>
                <Save size={15} />
                {reset ? '重置密码' : draft?.id ? '保存用户' : '创建账号'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function About() {
  const system = useSystem();
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/health')
      .then(setHealth)
      .catch((err) => setError(err.message));
  }, []);
  return (
    <div className="settings-page">
      <h2>关于系统</h2>
      <div className="about-identity">
        <Shield size={22} />
        <strong>Workflow Studio</strong>
        <span className="tag">v0.2.0</span>
      </div>
      <dl className="config-facts">
        <div>
          <dt>工作区</dt>
          <dd>{system.workspace.name}</dd>
        </div>
        <div>
          <dt>登录账号</dt>
          <dd>{system.user.username}</dd>
        </div>
        <div>
          <dt>服务状态</dt>
          <dd>{health?.status === 'ok' ? '已连接' : '连接中'}</dd>
        </div>
        <div>
          <dt>运行模式</dt>
          <dd>{health?.model_mode === 'demo' ? '离线演示' : health?.model_mode}</dd>
        </div>
        {Object.entries(health?.dependencies || {}).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
      <Feedback text={error} error />
      <a className="text-button" href="/docs" target="_blank" rel="noreferrer">
        API 文档
      </a>
    </div>
  );
}
