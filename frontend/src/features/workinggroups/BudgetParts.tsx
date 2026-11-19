import { Select, SelectItem } from '@carbon/react';
import type { WorkingGroupBudgetPeriod } from '../../api/generated/models';
import { formatCents } from '../orders/money';

export interface Figures {
  given: number;
  spent: number;
  reserved: number;
  free: number;
  /** Only where the whole budget is shown: what is not given to a group. */
  kept?: number;
}

export type MoneyFocus = 'spent' | 'reserved' | null;

export function PeriodSelect({
  id,
  periods,
  value,
  onChange,
}: {
  id: string;
  periods: readonly WorkingGroupBudgetPeriod[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select
      id={id}
      labelText="Budget period"
      hideLabel
      size="sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {periods.map((period) => (
        <SelectItem key={period.id} value={period.id} text={period.closed ? `${period.name} (closed)` : period.name} />
      ))}
    </Select>
  );
}

const COLUMNS = [
  { key: 'spent', label: 'Spent', phrase: 'Ordered, bought or booked' },
  { key: 'reserved', label: 'Reserved', phrase: 'Approved, not paid yet' },
  { key: 'free', label: 'Free', phrase: '' },
  { key: 'kept', label: 'Kept back', phrase: 'Not given to a group' },
] as const;

/** The budget card: the free amount, the period, the stacked bar and the figure columns. */
export function BudgetCard({
  label,
  figures,
  periods,
  periodId,
  onPeriod,
  focus,
  onFocus,
}: {
  label: string;
  figures: Figures;
  periods: readonly WorkingGroupBudgetPeriod[];
  periodId: string;
  onPeriod: (id: string) => void;
  focus?: MoneyFocus;
  /** Present where Spent and Reserved filter a list. */
  onFocus?: (focus: MoneyFocus) => void;
}) {
  const columns = COLUMNS.filter((column) => column.key !== 'kept' || figures.kept !== undefined);
  const value = (key: (typeof COLUMNS)[number]['key']) => figures[key] ?? 0;
  return (
    <section className="wg-sbar" aria-label={label}>
      <div className="wg-sbar__head">
        <div className="wg-sbar__sum">
          <span className="wg-sbar__n">{formatCents(figures.free)}</span>
          <span className="wg-sbar__l">
            free
            <small>of {formatCents(figures.given)} given</small>
          </span>
        </div>
        <div className="wg-sbar__period">
          <PeriodSelect id="wg-period" periods={periods} value={periodId} onChange={onPeriod} />
        </div>
      </div>
      <div className="wg-sbar__bar" aria-hidden="true">
        {columns
          .filter((column) => value(column.key) > 0)
          .map((column) => (
            <span
              key={column.key}
              className={`wg-sbar__seg wg-fin-${column.key}`}
              style={{ flexGrow: value(column.key) }}
            />
          ))}
      </div>
      <div className={`wg-sbar__cols wg-sbar__cols--${columns.length}`}>
        {columns.map((column) => {
          const body = (
            <>
              <span className="wg-sbar__cn">{formatCents(value(column.key))}</span>
              <span className="wg-sbar__cl">{column.label}</span>
              {column.phrase && <span className="wg-sbar__ch">{column.phrase}</span>}
            </>
          );
          const filter = column.key === 'spent' || column.key === 'reserved' ? column.key : null;
          return filter && onFocus ? (
            <button
              key={column.key}
              type="button"
              className={`wg-sbar__col wg-fin-${column.key}`}
              aria-pressed={focus === filter}
              onClick={() => onFocus(focus === filter ? null : filter)}
            >
              {body}
            </button>
          ) : (
            <div key={column.key} className={`wg-sbar__col wg-fin-${column.key}`}>
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}
