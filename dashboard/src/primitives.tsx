import type { ReactNode } from 'react';

export type StatCardProps = {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  /** Hash route. The whole card is the link. */
  readonly href?: string;
  /** Short marker, such as an unfiltered alert count. */
  readonly badge?: string;
};

/** White stat tile. The overview row links each card to its page. */
export function StatCard({ label, value, hint, icon, href, badge }: StatCardProps) {
  const body = (
    <>
      {icon !== undefined ? <span className="stat-card-icon">{icon}</span> : null}
      <div className="stat-card-copy">
        <p className="stat-card-value">{value}</p>
        <p className="stat-card-label">{label}</p>
        {hint !== undefined ? <p className="stat-card-hint">{hint}</p> : null}
      </div>
      {badge !== undefined ? <span className="stat-card-badge">{badge}</span> : null}
    </>
  );
  if (href !== undefined) {
    return (
      <a className="stat-card" href={href}>
        {body}
      </a>
    );
  }
  return <article className="stat-card">{body}</article>;
}

export type DataTableProps = {
  readonly caption?: string;
  readonly children: ReactNode;
};

/** Table chrome only. Callers keep their own rows and cell text. */
export function DataTable({ caption, children }: DataTableProps) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        {caption !== undefined ? <caption className="visually-hidden">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}
