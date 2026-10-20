import { CheckmarkFilled, Misuse } from '@carbon/icons-react';
import type { ReadinessItem } from './logic';

/** What is still missing before a request can be submitted or forwarded. */
export function ReadinessChecklist({ label, items, hint }: { label: string; items: ReadinessItem[]; hint?: string }) {
  return (
    <div>
      <p className="cds--label">{label}</p>
      <ul className="sales-checklist">
        {items.map((item) => (
          <li key={item.key}>
            {item.ok ? (
              <CheckmarkFilled className="sales-checklist__ok" aria-label="Done" />
            ) : (
              <Misuse className="sales-checklist__bad" aria-label="Missing" />
            )}
            <span className="mj-cell-stack">
              <span>{item.label}</span>
              {!item.ok && (
                <span className="mj-secondary">
                  {item.hint}
                  {item.key === 'po' && hint ? ` · ${hint}` : ''}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
