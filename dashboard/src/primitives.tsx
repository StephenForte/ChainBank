import type { ReactNode } from 'react';

export type StatCardProps = {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
};

/** White stat tile. T10.4 fills the overview row; this is the shell primitive. */
export function StatCard({ label, value, hint, icon }: StatCardProps) {
  return (
    <article className="stat-card">
      {icon !== undefined ? <span className="stat-card-icon">{icon}</span> : null}
      <div className="stat-card-copy">
        <p className="stat-card-value">{value}</p>
        <p className="stat-card-label">{label}</p>
        {hint !== undefined ? <p className="stat-card-hint">{hint}</p> : null}
      </div>
    </article>
  );
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
