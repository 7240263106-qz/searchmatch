import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Icon, type IconName } from './components/ui';
import WorkspaceLayout from './components/WorkspaceLayout';
import DashboardPage from './pages/DashboardPage';
import DocumentsPage from './pages/DocumentsPage';
import DocumentRunsPage from './pages/DocumentRunsPage';
import SearchPage from './pages/SearchPage';
import CompetitionDetailPage from './pages/CompetitionDetailPage';
import ReviewPage from './pages/ReviewPage';
import SourcesPage from './pages/SourcesPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import AgentPage from './pages/AgentPage';
import WebCollectionPage from './pages/WebCollectionPage';
import ReportsPage from './pages/ReportsPage';
import VerificationPage from './pages/VerificationPage';
import SettingsPage from './pages/SettingsPage';
import { api, getApiBaseInfo, getUser } from './lib/api';
import brandLogo from './assets/fhxc-logo.ico';

const APP_NAME = '方湖观澜';

const NAV: Array<{ to: string; label: string; description: string; icon: IconName }> = [
  { to: '/overview', label: '总览分析', description: '数据统计与质量报告', icon: 'dashboard' },
  { to: '/collection', label: '信息采集', description: '文档、官网与信息源', icon: 'upload' },
  { to: '/library', label: '竞赛库', description: '查询、审核与订阅', icon: 'search' },
  { to: '/settings', label: '系统设置', description: '模型接入与运行配置', icon: 'settings' },
];

const WORKSPACES = {
  overview: {
    title: '总览分析',
    description: '查看竞赛收录、报名动态与数据质量。',
    sections: [
      { path: '/overview', label: '竞赛总览' },
      { path: '/overview/quality', label: '质量报告' },
    ],
  },
  collection: {
    title: '信息采集',
    description: '从文档和官网收集赛事资料，管理信息源并检查采集结果。',
    sections: [
      { path: '/collection', label: '文档录入', relatedPath: '/collection/documents/' },
      { path: '/collection/web', label: '官网采集' },
      { path: '/collection/sources', label: '信息源' },
      { path: '/collection/testing', label: '采集测试' },
    ],
  },
  library: {
    title: '竞赛库',
    description: '查找已收录的竞赛，核对待审核内容并查看订阅规则。',
    sections: [
      { path: '/library', label: '竞赛检索' },
      { path: '/library/review', label: '竞赛审核' },
      { path: '/library/assistant', label: '对话检索' },
      { path: '/library/subscriptions', label: '订阅管理', hint: '推送待开放' },
    ],
  },
};

// Preserve shared bookmarks, selected document runs and review-task query parameters.
function LegacyRedirect({ to, status }: { to: string; status?: 'draft' }): JSX.Element {
  const { search, hash } = useLocation();
  const { documentId } = useParams();
  const pathname = to.replace(':documentId', encodeURIComponent(documentId ?? ''));
  const params = new URLSearchParams(search);
  if (status) params.set('status', status);
  return <Navigate replace to={{ pathname, search: status ? '?' + params.toString() : search, hash }} />;
}

function readTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App(): JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  const [devIdentityEnabled, setDevIdentityEnabled] = useState(false);
  const [clientBaseSource, setClientBaseSource] = useState<'configured' | 'same_origin'>(
    () => getApiBaseInfo().source,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const user = getUser();
  const isAdmin = user.roles.includes('admin');
  const visibleNav = isAdmin ? NAV : NAV.filter((item) => item.to !== '/settings');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    setClientBaseSource(getApiBaseInfo().source);
  }, [location.pathname]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<{ devIdentityEnabled: boolean }>('/system-settings')
      .then((data) => setDevIdentityEnabled(data.devIdentityEnabled))
      .catch(() => setDevIdentityEnabled(false));
  }, [isAdmin]);

  const base = location.pathname.startsWith('/competitions/')
    ? '竞赛详情'
    : location.pathname.startsWith('/collection/documents/') ? '文档运行详情'
    : location.pathname.startsWith('/settings')
      ? '系统设置'
      : (NAV.find((item) => location.pathname.startsWith(item.to))?.label ?? APP_NAME);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={brandLogo} width={34} height={34} alt="方湖信创工作室" />
          <div>
            <div className="brand-title">{APP_NAME}</div>
            <div className="brand-sub">学科竞赛信息智能感知平台</div>
          </div>
        </div>

        <nav aria-label="主导航">
          <div className="nav-group-label">工作台</div>
          {visibleNav.map((item) => {
            const active = location.pathname.startsWith(item.to) || (item.to === '/library' && location.pathname.startsWith('/competitions/'));
            return (
              <Link
                key={item.to}
                to={item.to}
                title={`${item.label} · ${item.description}`}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                className={`nav-item${active ? ' active' : ''}`}
              >
                <Icon name={item.icon} />
                <span className="nav-copy"><span>{item.label}</span><small>{item.description}</small></span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div>竞赛信息收集智能体 v0.1</div>
          <div>不代报名 · 不认定评优等级</div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <span className="topbar-title">{base}</span>
            <span className="topbar-sub">/ {new Date().toLocaleDateString('zh-CN')}</span>
          </div>
          <div className="topbar-spacer" />
          <span className="nav-badge" title={getApiBaseInfo().apiBaseUrl}>
            客户端基地址：{clientBaseSource === 'configured' ? '运行期下发' : '同源兜底'}
          </span>
          {devIdentityEnabled && (
            <span className="nav-badge" title="当前为开发身份模拟，非真实鉴权">
              开发身份模拟中
            </span>
          )}
          <div className="topbar-search">
            <Icon name="search" size={14} />
            <input
              placeholder="搜索竞赛、主办方…"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const value = (event.target as HTMLInputElement).value.trim();
                  navigate(value ? `/library?q=${encodeURIComponent(value)}` : '/library');
                }
              }}
            />
          </div>
          <button
            className="icon-button"
            aria-label="切换主题"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          <div className="avatar" title={`${user.name}（${user.roles.join(' / ')}）`}>
            {user.name.slice(0, 1)}
          </div>
        </div>

        <Routes>
          <Route path="/overview" element={<WorkspaceLayout {...WORKSPACES.overview} />}>
            <Route index element={<DashboardPage />} />
            <Route path="quality" element={<ReportsPage />} />
          </Route>
          <Route path="/collection" element={<WorkspaceLayout {...WORKSPACES.collection} />}>
            <Route index element={<DocumentsPage />} />
            <Route path="web" element={<WebCollectionPage />} />
            <Route path="sources" element={<SourcesPage />} />
            <Route path="testing" element={<VerificationPage />} />
            <Route path="documents/:documentId/runs" element={<DocumentRunsPage />} />
          </Route>
          <Route path="/library" element={<WorkspaceLayout {...WORKSPACES.library} />}>
            <Route index element={<SearchPage />} />
            <Route path="drafts" element={<LegacyRedirect to="/library/review" status="draft" />} />
            <Route path="assistant" element={<AgentPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
          </Route>
          <Route path="/competitions/:id" element={<CompetitionDetailPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/" element={<LegacyRedirect to="/overview" />} />
          <Route path="/documents" element={<LegacyRedirect to="/collection" />} />
          <Route path="/documents/:documentId/runs" element={<LegacyRedirect to="/collection/documents/:documentId/runs" />} />
          <Route path="/search" element={<LegacyRedirect to="/library" />} />
          <Route path="/review" element={<LegacyRedirect to="/library/review" />} />
          <Route path="/verification" element={<LegacyRedirect to="/collection/testing" />} />
          <Route path="/sources" element={<LegacyRedirect to="/collection/sources" />} />
          <Route path="/subscriptions" element={<LegacyRedirect to="/library/subscriptions" />} />
          <Route path="/agent" element={<LegacyRedirect to="/collection/web" />} />
          <Route path="/reports" element={<LegacyRedirect to="/overview/quality" />} />
        </Routes>
      </main>
    </div>
  );
}
