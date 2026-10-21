import { ProgressBar } from '@carbon/react';

/** Compact "Bar 2/3" meter. Without a name it is a plain filled/required meter (event list, summaries). */
export function FillMeter({ name, filled, required }: { name?: string; filled: number; required: number }) {
  const shown = Math.min(filled, required);
  const label = `${name ? `${name}: ` : 'Staffing: '}${shown} of ${required} places filled`;
  return (
    <div className="ev-meter">
      <span className="ev-meter__label" aria-hidden="true">
        {name ? `${name} ` : ''}
        <strong>
          {shown}/{required}
        </strong>
      </span>
      <ProgressBar label={label} hideLabel size="small" value={shown} max={Math.max(required, 1)} />
    </div>
  );
}
