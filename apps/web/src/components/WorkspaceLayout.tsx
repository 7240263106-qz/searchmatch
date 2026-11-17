import { Link, Outlet, useLocation } from 'react-router-dom';
import { PageHeader, PageHeaderLevel } from './ui';

interface WorkspaceSection {
  path: string;
  label: string;
  hint?: string;
  relatedPath?: string;
}

export default function WorkspaceLayout({
  title,
  description,
  sections,
}: {
  title: string;
  description: string;
  sections: WorkspaceSection[];
}): JSX.Element {
  const { pathname } = useLocation();

  return (
    <>
      <PageHeader title={title} description={description} />
      <nav className="workspace-nav" aria-label={`${title}功能`}>
        {sections.map((section) => {
          const active = pathname === section.path || Boolean(section.relatedPath && pathname.startsWith(section.relatedPath));
          return (
            <Link
              key={section.path}
              to={section.path}
              className={`workspace-link${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {section.label}
              {section.hint && <span className="workspace-hint">{section.hint}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="workspace-content">
        <PageHeaderLevel value={2}>
          <Outlet />
        </PageHeaderLevel>
      </div>
    </>
  );
}
