import { useState, type ReactNode } from 'react';

export type CollapsibleSectionProps = {
  readonly title: string;
  readonly count?: number;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
};

/**
 * Hides secondary rows (disabled entities, quiet detail) behind a +/- control.
 * Do not put unacknowledged critical findings here — those stay visible (C20).
 */
export function CollapsibleSection({ title, count, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  if (count === 0) {
    return null;
  }

  const label = count === undefined ? title : `${title} (${String(count)})`;

  return (
    <div className="collapse-block">
      <button
        type="button"
        className="collapse-toggle"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((previous) => !previous);
        }}
      >
        <span className="collapse-mark" aria-hidden="true">
          {isOpen ? '−' : '+'}
        </span>
        {label}
      </button>
      {isOpen ? <div className="collapse-body">{children}</div> : null}
    </div>
  );
}
