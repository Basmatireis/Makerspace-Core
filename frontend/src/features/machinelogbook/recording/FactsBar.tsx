import type { ReactNode } from 'react';
import { Accordion, AccordionItem, Tile } from '@carbon/react';
import './recording.scss';

export type Fact = { label: string; value: ReactNode; note?: ReactNode };

/**
 * A few headline figures in one row; everything else behind a "Details" disclosure.
 * `detailsLayout="tiles"` renders the details as a grid of label/value tiles like the headline figures.
 */
export function FactsBar({
  metrics,
  details,
  detailsLayout = 'list',
}: {
  metrics: Fact[];
  details: Fact[];
  detailsLayout?: 'list' | 'tiles';
}) {
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
            {detailsLayout === 'tiles' ? (
              <dl className="facts-bar__tiles">
                {details.map((detail) => (
                  <Tile key={detail.label} className="facts-bar__tile">
                    <dt>{detail.label}</dt>
                    <dd className="facts-bar__value">{detail.value}</dd>
                    {detail.note && <dd className="mj-secondary">{detail.note}</dd>}
                  </Tile>
                ))}
              </dl>
            ) : (
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
            )}
          </AccordionItem>
        </Accordion>
      )}
    </Tile>
  );
}
