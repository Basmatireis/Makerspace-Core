import type { ReactNode } from 'react';
import { Accordion, AccordionItem, Tile } from '@carbon/react';
import './recording.scss';

export type Fact = { label: string; value: ReactNode; note?: ReactNode };

/** A few headline figures in one row; everything else behind a "Details" disclosure. */
export function FactsBar({ metrics, details }: { metrics: Fact[]; details: Fact[] }) {
  return (
    <Tile className="facts-bar">
      <dl className="facts-bar__metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="facts-bar__metric">
            <dt>{metric.label}</dt>
            <dd className="facts-bar__value">{metric.value}</dd>
            {metric.note && <dd className="mj-secondary">{metric.note}</dd>}
          </div>
        ))}
      </dl>
      {details.length > 0 && (
        <Accordion size="sm" className="facts-bar__details">
          <AccordionItem title="Details">
            <dl className="mj-facts">
              {details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd className="mj-cell-stack">
                    <span>{detail.value}</span>
                    {detail.note && <span className="mj-secondary">{detail.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </AccordionItem>
        </Accordion>
      )}
    </Tile>
  );
}
