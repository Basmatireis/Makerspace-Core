import {
  STATUS_COLUMNS,
  daysBetween,
  isMineTask,
  isOpen,
  plural,
  statusOf,
  type StatusKey,
  type Task,
} from './taskModel';

export type ScopeFilter = 'unassigned' | 'mine' | null;

interface Props {
  tasks: readonly Task[];
  today: string;
  me: string;
  status: StatusKey | null;
  scope: ScopeFilter;
  onStatus: (status: StatusKey | null) => void;
  onScope: (scope: ScopeFilter) => void;
}

/** The three cards above the list: the status bar with its filter columns, "Unassigned" and "Mine". */
export function TaskSummary({ tasks, today, me, status, scope, onStatus, onScope }: Props) {
  const open = tasks.filter(isOpen);
  const counts: Record<StatusKey, number> = { inbox: 0, overdue: 0, week: 0, later: 0 };
  for (const task of open) {
    const key = statusOf(task, today);
    if (key) counts[key] += 1;
  }
  const tickets = open.filter((task) => task.kind === 'ticket').length;
  const repeating = open.filter((task) => task.repeatEveryDays).length;
  const thisWeek = (task: Task) => statusOf(task, today) === 'week';

  const unassigned = open.filter((task) => !task.assignee);
  const waiting = unassigned
    .filter((task) => task.kind === 'ticket')
    .map((task) => daysBetween(task.createdAt, today))
    .reduce<number | null>((longest, days) => (longest === null ? days : Math.max(longest, days)), null);

  const mine = open.filter((task) => isMineTask(task, me));
  const assigned = mine.filter((task) => task.assignee?.personId === me);

  return (
    <div className="wg-summary">
      <section className="wg-sbar" aria-label="Open tickets and to-dos">
        <div className="wg-sbar__head">
          <div className="wg-sbar__sum">
            <span className="wg-sbar__n">{open.length}</span>
            <span className="wg-sbar__l">
              open
              <small>tickets and to-dos</small>
            </span>
          </div>
          <span className="wg-sbar__facts">
            {plural(tickets, 'ticket')} · {plural(open.length - tickets, 'to-do')} · {repeating} repeating
          </span>
        </div>
        <div className="wg-sbar__bar" aria-hidden="true">
          {STATUS_COLUMNS.filter((column) => counts[column.key] > 0).map((column) => (
            <span
              key={column.key}
              className={`wg-sbar__seg wg-st-${column.key}`}
              style={{ flexGrow: counts[column.key] }}
            />
          ))}
        </div>
        <div className="wg-sbar__cols">
          {STATUS_COLUMNS.map((column) => (
            <button
              key={column.key}
              type="button"
              className={`wg-sbar__col wg-st-${column.key}`}
              aria-pressed={status === column.key}
              onClick={() => onStatus(status === column.key ? null : column.key)}
            >
              <span className="wg-sbar__cn">{counts[column.key]}</span>
              <span className="wg-sbar__cl">{column.label}</span>
            </button>
          ))}
        </div>
      </section>

      <Tile
        title="Unassigned"
        count={unassigned.length}
        pressed={scope === 'unassigned'}
        onClick={() => onScope(scope === 'unassigned' ? null : 'unassigned')}
        rows={[
          ['Tickets', String(unassigned.filter((task) => task.kind === 'ticket').length)],
          ['To-dos', String(unassigned.filter((task) => task.kind === 'todo').length)],
          ['Waiting longest', waiting === null ? '–' : plural(waiting, 'day')],
          ['Due this week', String(unassigned.filter(thisWeek).length)],
        ]}
      />
      <Tile
        title="Mine"
        count={mine.length}
        pressed={scope === 'mine'}
        onClick={() => onScope(scope === 'mine' ? null : 'mine')}
        rows={[
          ['Assigned', String(assigned.length)],
          [
            'Written or followed',
            String(mine.filter((task) => task.kind === 'ticket' && task.assignee?.personId !== me).length),
          ],
          ['Overdue', String(mine.filter((task) => statusOf(task, today) === 'overdue').length)],
          ['Due this week', String(mine.filter(thisWeek).length)],
        ]}
      />
    </div>
  );
}

export function Tile({
  title,
  count,
  pressed,
  onClick,
  rows,
}: {
  title: string;
  count: number | string;
  /** Without a click handler the tile only shows figures. */
  pressed?: boolean;
  onClick?: () => void;
  rows: [string, string][];
}) {
  const body = (
    <>
      <span className="wg-minetile__head">
        <span className="wg-minetile__title">{title}</span>
        <span className="wg-minetile__n">{count}</span>
      </span>
      {rows.map(([label, value]) => (
        <span key={label} className="wg-minetile__row">
          <span>{label}</span>
          <span>{value}</span>
        </span>
      ))}
    </>
  );
  return onClick ? (
    <button type="button" className="wg-minetile" aria-pressed={pressed} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="wg-minetile wg-minetile--static">{body}</div>
  );
}
