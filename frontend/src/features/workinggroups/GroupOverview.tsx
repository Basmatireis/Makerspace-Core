import type { ReactNode } from 'react';
import { Button, Link as CarbonLink, Tag, Tile } from '@carbon/react';
import { Add, Checkmark, Document, Launch, Tools, TrashCan, UserMultiple, Wallet } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  WorkingGroup,
  WorkingGroupNote,
  WorkingGroupPerson,
  WorkingGroupStatus,
  WorkingGroupStatusItem,
  WorkingGroupSummary,
} from '../../api/generated/models';
import { dateInAppTimeZone } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { formatMoney } from '../orders/formatting';
import { toCents } from '../orders/money';
import { budgetOptions } from './financeQueries';
import { ChangeStatusDialog, PinNoteDialog } from './StatusParts';
import { WriteTicketDialog } from './TaskDialogs';
import {
  LATELY_FIRST,
  canManageWorkingGroups,
  workingGroupActivityOptions,
  workingGroupNotesOptions,
  workingGroupOptions,
  workingGroupStatusOptions,
  workingGroupTicketsOptions,
  workingGroupTodosOptions,
} from './queries';
import { STATUS_LABEL, STATUS_WINDOW_DAYS, backAround, taskLink, type StatusTarget } from './statusModel';
import {
  bucketOf,
  dateParts,
  daysBetween,
  firstName,
  isOpen,
  personName,
  plural,
  ticketTask,
  todayOn,
  todoTask,
  type Task,
} from './taskModel';
import { Avatar } from './TaskList';
import { useDialogOpener } from './useDialogOpener';
import { Lately } from './Lately';
import { OpenButton, RowComments } from './RowComments';
import { useNoteRemoval } from './useNoteRemoval';

function isHttps(url: string | undefined): url is string {
  try {
    return url !== undefined && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** "12 Nov" for a plain date or, in the app time zone, for a timestamp. */
function shortDate(value: string): string {
  const day = value.length > 10 ? dateInAppTimeZone(new Date(value)) : value;
  const parts = dateParts(day);
  return `${parts.day} ${parts.month}`;
}

const age = (days: number) => (days === 0 ? 'today' : plural(days, 'day'));

/** Working groups → Overview of one group. People inside see the working view, everybody else the public side. */
export function GroupOverview({ summary }: { summary: WorkingGroupSummary }) {
  const currentUser = useCurrentUser();
  const inside = summary.isMember || summary.isLead || canManageWorkingGroups(currentUser);
  const detail = useQuery(workingGroupOptions(summary.id));
  return (
    <QueryBoundary query={detail} errorMessage="The working group could not be loaded.">
      {(group) =>
        inside ? (
          <InsideOverview summary={summary} group={group} />
        ) : (
          <OutsideOverview summary={summary} group={group} />
        )
      }
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pinboard table
// ---------------------------------------------------------------------------------------------------------------

type PinKind = 'ticket' | 'todo' | 'overdue' | 'group-note' | 'public-note' | 'note';

interface PinRow {
  id: string;
  kind: PinKind;
  title: string;
  /** The second line under the title; notes have none. */
  line?: string;
  from: { person?: WorkingGroupPerson; name: string; sub: string };
  when: { date: string; sub: string };
  task?: Task;
  note?: WorkingGroupNote;
}

const PIN_LABEL: Record<PinKind, string> = {
  ticket: 'Unassigned ticket',
  todo: 'Unassigned to-do',
  overdue: 'Overdue to-do',
  'group-note': 'Group note',
  'public-note': 'Public note',
  note: 'Note',
};

const PIN_TAG: Record<PinKind, 'blue' | 'purple' | 'red' | 'teal' | 'outline'> = {
  ticket: 'blue',
  todo: 'purple',
  overdue: 'red',
  'group-note': 'outline',
  'public-note': 'teal',
  note: 'outline',
};

function noteRow(note: WorkingGroupNote, group: WorkingGroup, inside: boolean): PinRow {
  const lead = group.lead?.personId !== undefined && note.author?.personId === group.lead.personId;
  return {
    id: `note:${note.id}`,
    kind: inside ? (note.public ? 'public-note' : 'group-note') : 'note',
    title: note.text,
    from: { person: note.author, name: personName(note.author), sub: lead ? 'Group lead' : 'Member' },
    when: { date: shortDate(note.createdAt), sub: 'Pinned' },
    note,
  };
}

function PersonCell({ from }: { from: PinRow['from'] }) {
  return (
    <span className="wg-from">
      {from.person ? <Avatar name={from.person} /> : null}
      <span className="wg-from__t">
        <span>{from.name}</span>
        <small>{from.sub}</small>
      </span>
    </span>
  );
}

function PinboardTable({
  groupId,
  rows,
  label,
  sub,
  toolbarAction,
}: {
  groupId: string;
  rows: PinRow[];
  label: string;
  sub?: string;
  toolbarAction: ReactNode;
}) {
  const removal = useNoteRemoval();
  const columns: Column<PinRow>[] = [
    {
      key: 'kind',
      header: 'Kind',
      className: 'wg-pin__kind',
      render: (row) => (
        <span className={`wg-pin wg-pin--${row.kind}`}>
          <Tag size="sm" type={PIN_TAG[row.kind]}>
            {PIN_LABEL[row.kind]}
          </Tag>
        </span>
      ),
    },
    {
      key: 'message',
      header: 'Message',
      className: 'wg-pin__msg',
      render: (row) => (
        <span className="wg-msg">
          {row.line ? <strong>{row.title}</strong> : <span>{row.title}</span>}
          {row.line && <span className="wg-msg__line">{row.line}</span>}
          {row.task && row.task.commentCount > 0 && <RowComments task={row.task} />}
        </span>
      ),
    },
    { key: 'from', header: 'From', narrow: true, render: (row) => <PersonCell from={row.from} /> },
    {
      key: 'when',
      header: 'When',
      narrow: true,
      className: 'wg-pin__when',
      render: (row) => (
        <span className="wg-from__t">
          <span>{row.when.date}</span>
          <small>{row.when.sub}</small>
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'wg-actions-cell',
      render: (row) => (
        <span className="wg-actions">
          {row.task && <OpenButton task={row.task} />}
          {row.note && row.note.canDelete && (
            <Button
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={TrashCan}
              iconDescription="Remove note"
              tooltipPosition="left"
              disabled={removal.pending}
              onClick={() => row.note && removal.request(row.note)}
            />
          )}
        </span>
      ),
    },
  ];
  return (
    <section className="wg-ov-board" aria-labelledby={`wg-pinboard-title-${groupId}`}>
      <header className="wg-ov-board__head">
        <h2 id={`wg-pinboard-title-${groupId}`} className="wg-ov-board__title">
          {label}
        </h2>
        {sub && <p className="wg-muted">{sub}</p>}
      </header>
      <div id={removal.frameId} tabIndex={-1} className="wg-focus wg-pinboard">
        <DirectoryTable
          id={`wg-pinboard-${groupId}`}
          urlPrefix="pin"
          label={label}
          columns={columns}
          rows={rows}
          totalCount={rows.length}
          searchText={(row) => `${PIN_LABEL[row.kind]} ${row.title} ${row.line ?? ''} ${row.from.name}`}
          defaultSort={{ key: '', direction: 'ASC' }}
          pageSizes={[10, 20, 50, 100]}
          toolbarAction={toolbarAction}
          empty={{ title: 'Nothing pinned', description: 'Notes and open items show up here.' }}
        />
      </div>
      {removal.dialog}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------------------------------------------

function StatTile({
  icon,
  value,
  label,
  rows,
  bar,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  rows: [string, ReactNode][];
  bar?: ReactNode;
}) {
  return (
    <Tile className="wg-ov-stat">
      {icon}
      <span className="wg-ov-stat__value">{value}</span>
      <span className="wg-ov-stat__label">{label}</span>
      <span className="wg-ov-stat__more">
        {bar}
        {rows.map(([name, figure]) => (
          <span key={name} className="wg-kv">
            <span>{name}</span>
            <strong>{figure}</strong>
          </span>
        ))}
      </span>
    </Tile>
  );
}

/** Per machine and place: how long it was usable in the last 90 days and its open tickets; a click changes the status. */
function MachinesTile({
  groupId,
  items,
  tickets,
  onChangeStatus,
}: {
  groupId: string;
  items: MachineRow[];
  /** Open tickets of the group; without them (people outside) the ticket counts are left out. */
  tickets?: Task[];
  onChangeStatus?: (target: StatusTarget) => void;
}) {
  const places = items.some((item) => item.kind === 'place');
  const total = items.reduce((sum, item) => sum + (item.daysOff ?? 0), 0);
  const loaded = items.some((item) => item.daysOff !== undefined);
  const title = `${places ? 'Machines and places' : 'Machines'}, last ${STATUS_WINDOW_DAYS} days`;
  return (
    <Tile className={`wg-ov-stat wg-ov-machines${tickets ? '' : ' wg-ov-machines--plain'}`}>
      <Tools size={20} aria-hidden />
      <span className="wg-ov-stat__label">{title}</span>
      {items.length === 0 ? (
        <span className="wg-muted">No machines or places yet.</span>
      ) : (
        <ul className="wg-rank" aria-label={title}>
          {items.map((item) => {
            const open = tickets?.filter((task) => task.ticket?.machineId === item.id).length;
            const off = item.daysOff;
            // The off share of the 90 days, at least a visible sliver when there was any day off.
            const offShare = off ? Math.max(12, Math.round((off / STATUS_WINDOW_DAYS) * 100)) : 0;
            const detail =
              item.status === 'ok'
                ? null
                : [STATUS_LABEL[item.status], item.note, backAround(item.until)].filter(Boolean).join(' · ');
            return (
              <li key={item.id} className={`wg-rank__row wg-rank__row--${item.status}`}>
                <span className="wg-rank__name">
                  {onChangeStatus ? (
                    <Button
                      kind="ghost"
                      size="sm"
                      className="wg-rank__btn"
                      title={item.name}
                      aria-label={`Change status of ${item.name}`}
                      onClick={() =>
                        onChangeStatus({
                          kind: item.kind,
                          id: item.id,
                          groupId,
                          name: item.name,
                          status: item.status,
                          note: item.note,
                          until: item.until,
                        })
                      }
                    >
                      {item.name}
                    </Button>
                  ) : (
                    <span>{item.name}</span>
                  )}
                  {detail && <small title={detail}>{detail}</small>}
                </span>
                {off === undefined ? (
                  <span className="wg-rank__bar wg-rank__bar--unknown" />
                ) : (
                  <span
                    className="wg-rank__bar"
                    role="img"
                    aria-label={`${item.name}: ${plural(off, 'day')} of ${STATUS_WINDOW_DAYS} not fully usable`}
                  >
                    {offShare > 0 && <i style={{ inlineSize: `${offShare}%` }} />}
                  </span>
                )}
                <span className="wg-rank__v">{off === undefined ? '–' : off === 0 ? 'always on' : `${off} d off`}</span>
                {open !== undefined && <span className="wg-rank__j">{open > 0 ? plural(open, 'ticket') : '–'}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {loaded && <span className="wg-ov-stat__foot">{plural(total, 'day')} not fully usable in total</span>}
    </Tile>
  );
}

interface MachineRow {
  kind: 'machine' | 'place';
  id: string;
  name: string;
  status: WorkingGroupStatus;
  note?: string;
  until?: string;
  /** Absent until the status list has loaded. */
  daysOff?: number;
}

/** The group's machines, then its places, each with its status and, from the status list, the days it was not ok. */
function machineRows(group: WorkingGroup, status: WorkingGroupStatusItem[] | undefined): MachineRow[] {
  const byId = new Map((status ?? []).map((item) => [item.id, item]));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const row = (kind: MachineRow['kind'], item: WorkingGroup['machines'][number]): MachineRow => {
    const known = byId.get(item.id);
    return {
      kind,
      id: item.id,
      name: item.name,
      status: known?.status ?? item.status ?? 'ok',
      note: known?.note ?? item.note,
      until: known?.until ?? item.until,
      daysOff: known?.daysNotOkLast90,
    };
  };
  return [
    ...[...group.machines].sort(byName).map((item) => row('machine', item)),
    ...[...group.places].sort(byName).map((item) => row('place', item)),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Side tiles
// ---------------------------------------------------------------------------------------------------------------

function SideTile({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Tile className="wg-ov-side" aria-label={title}>
      <h3 className="wg-ov-side__title">
        {title}
        {count !== undefined && <span className="wg-muted">{count}</span>}
      </h3>
      {children}
    </Tile>
  );
}

function NextTodos({ todos, today }: { todos: Task[]; today: string }) {
  const next = [...todos].sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? '')).slice(0, 5);
  return (
    <SideTile title="Next to-dos" count={next.length}>
      {next.length === 0 ? (
        <p className="wg-muted">No to-do is due.</p>
      ) : (
        <ul className="wg-ov-rows">
          {next.map((task) => {
            const days = task.dueOn ? daysBetween(today, task.dueOn) : null;
            const tone = days === null ? '' : days <= 0 ? ' wg-when--today' : days < 7 ? ' wg-when--soon' : '';
            const hint =
              days === null
                ? 'No due date'
                : days < 0
                  ? `${plural(-days, 'day')} late`
                  : days === 0
                    ? 'due today'
                    : `due in ${plural(days, 'day')}`;
            return (
              <li key={task.key} className="wg-ov-row">
                <span className="wg-ov-row__main">
                  <CarbonLink as={Link} to={taskLink(task)}>
                    {task.title}
                  </CarbonLink>
                  <small>
                    {task.assignee ? personName(task.assignee) : 'Unassigned'}
                    {task.repeatEveryDays ? ` · every ${plural(task.repeatEveryDays, 'day')}` : ''}
                  </small>
                </span>
                <span className={`wg-when${tone}`}>
                  {task.dueOn ? shortDate(task.dueOn) : ''}
                  <small>{hint}</small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SideTile>
  );
}

function People({ group, open, inside }: { group: WorkingGroup; open?: Task[]; inside: boolean }) {
  const members = [...group.members].sort(
    (a, b) => Number(b.isLead) - Number(a.isLead) || a.displayName.localeCompare(b.displayName),
  );
  const chat = inside && isHttps(group.chatUrl) ? new URL(group.chatUrl) : null;
  return (
    <SideTile title="People" count={members.length}>
      {members.length === 0 ? (
        <p className="wg-muted">This group has no members.</p>
      ) : (
        <ul className="wg-ov-rows">
          {members.map((member) => {
            const mine = (open ?? []).filter((task) => task.assignee?.personId === member.personId);
            const todos = mine.filter((task) => task.kind === 'todo').length;
            const tickets = mine.length - todos;
            const load = [todos > 0 && plural(todos, 'to-do'), tickets > 0 && plural(tickets, 'ticket')]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={member.personId} className="wg-ov-row">
                <Avatar name={member} />
                <span className="wg-ov-row__main">
                  <span>{member.displayName}</span>
                  {open && <small>{load || 'Nothing open'}</small>}
                </span>
                {member.isLead && (
                  <Tag size="sm" type="purple">
                    Group lead
                  </Tag>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {chat && (
        <div className="wg-ov-row wg-ov-row--chat">
          <span className="wg-ov-row__main">
            <span>Group chat</span>
            <small>{chat.host}</small>
          </span>
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Launch}
            href={chat.href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open the group chat"
          >
            Open
          </Button>
        </div>
      )}
    </SideTile>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Inside
// ---------------------------------------------------------------------------------------------------------------

function InsideOverview({ summary, group }: { summary: WorkingGroupSummary; group: WorkingGroup }) {
  const currentUser = useCurrentUser();
  const today = todayOn();
  const tickets = useQuery(workingGroupTicketsOptions);
  const todos = useQuery(workingGroupTodosOptions);
  const notes = useQuery(workingGroupNotesOptions(group.id));
  const status = useQuery(workingGroupStatusOptions);
  const activity = useQuery(workingGroupActivityOptions(group.id, LATELY_FIRST));
  // The budget lists the groups the caller is a member of; finance managers see every group.
  const budget = useQuery({
    ...budgetOptions({}),
    enabled:
      summary.isMember || summary.isLead || hasPermission(currentUser, PermissionId.working_group_financesmanage),
  });
  const pin = useDialogOpener();
  const change = useDialogOpener<StatusTarget>();

  const groupTickets = (tickets.data?.items ?? [])
    .filter((ticket) => ticket.groupId === group.id)
    .map(ticketTask)
    .filter(isOpen);
  const groupTodos = (todos.data?.items ?? [])
    .filter((todo) => todo.groupId === group.id)
    .map(todoTask)
    .filter(isOpen);
  const unassignedTickets = groupTickets.filter((task) => !task.assignee);
  const unassignedTodos = groupTodos.filter((task) => !task.assignee);
  const overdueTodos = groupTodos.filter((task) => bucketOf(task, today) === 'overdue');
  const oldest = groupTickets.reduce<string | null>(
    (min, task) => (min === null || task.createdAt < min ? task.createdAt : min),
    null,
  );
  const lastActivity = activity.data?.items[0]?.at;

  const rows: PinRow[] = [
    ...unassignedTickets.map((task): PinRow => ({
      id: task.key,
      kind: 'ticket',
      title: task.title,
      line: 'No one is assigned to this ticket yet.',
      from: { person: task.author, name: personName(task.author), sub: 'wrote it' },
      when: { date: shortDate(task.createdAt), sub: 'Written' },
      task,
    })),
    ...unassignedTodos.map((task): PinRow => ({
      id: task.key,
      kind: 'todo',
      title: task.title,
      line: `No one is assigned yet${task.repeatEveryDays ? ` · repeats every ${plural(task.repeatEveryDays, 'day')}` : ''}.`,
      from: { name: 'Unassigned', sub: 'Nobody has it yet' },
      when: { date: task.dueOn ? shortDate(task.dueOn) : '', sub: 'Due' },
      task,
    })),
    ...overdueTodos
      .filter((task) => task.assignee)
      .map((task): PinRow => {
        const late = task.dueOn ? -daysBetween(today, task.dueOn) : 0;
        return {
          id: task.key,
          kind: 'overdue',
          title: task.title,
          line: `Was due ${plural(late, 'day')} ago.`,
          from: { person: task.assignee, name: personName(task.assignee), sub: 'has it' },
          when: { date: task.dueOn ? shortDate(task.dueOn) : '', sub: 'Was due' },
          task,
        };
      }),
    ...[...(notes.data?.items ?? [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((note) => noteRow(note, group, true)),
  ];
  const attention = rows.filter((row) => row.task).length;
  const noteCount = rows.length - attention;

  const machines = machineRows(group, status.data?.items);
  const share = budget.data?.groups.find((entry) => entry.groupId === group.id);
  const used = share ? toCents(share.spent) + toCents(share.reserved) : 0;
  const given = share ? toCents(share.given) : 0;

  return (
    <div className="wg-ov">
      <div className="wg-ov-stats">
        <StatTile
          icon={<UserMultiple size={20} aria-hidden />}
          value={group.memberCount}
          label="People"
          rows={[
            ...(group.lead ? [['Group lead', firstName(group.lead)] as [string, string]] : []),
            ['Last activity', lastActivity ? shortDate(lastActivity) : '–'],
          ]}
        />
        <StatTile
          icon={<Document size={20} aria-hidden />}
          value={summary.openTicketCount ?? groupTickets.length}
          label="Open tickets"
          rows={[
            ['New', groupTickets.filter((task) => task.state === 'new').length],
            ['Unassigned', unassignedTickets.length],
            ['Oldest', oldest ? age(daysBetween(dateInAppTimeZone(new Date(oldest)), today)) : '–'],
          ]}
        />
        <StatTile
          icon={<Checkmark size={20} aria-hidden />}
          value={summary.openTodoCount ?? groupTodos.length}
          label="Open to-dos"
          rows={[
            ['Yours', groupTodos.filter((task) => task.isMine).length],
            ['Overdue', overdueTodos.length],
            ['Repeating', groupTodos.filter((task) => task.repeatEveryDays).length],
          ]}
        />
        {share && (
          <StatTile
            icon={<Wallet size={20} aria-hidden />}
            value={formatMoney(share.free)}
            label="Budget free"
            bar={
              <span
                className="wg-ov-money"
                role="img"
                aria-label={`${formatMoney(share.spent)} spent and ${formatMoney(share.reserved)} reserved of ${formatMoney(share.given)}`}
              >
                <i style={{ inlineSize: `${Math.min(100, Math.round((used / (given || 1)) * 100))}%` }} />
              </span>
            }
            rows={[
              ['Given', formatMoney(share.given)],
              ['Spent', formatMoney(share.spent)],
              ['Reserved', formatMoney(share.reserved)],
            ]}
          />
        )}
      </div>
      <div className="wg-ov-main">
        <PinboardTable
          groupId={group.id}
          rows={rows}
          label="Group pinboard"
          sub={`${attention > 0 ? `${attention} unassigned or overdue` : 'Nothing unassigned or overdue'} · ${plural(noteCount, 'note')}`}
          toolbarAction={
            <Button renderIcon={Add} onClick={() => pin.open(true)}>
              Pin a note
            </Button>
          }
        />
      </div>
      <aside className="wg-ov-side-col" aria-label="Group details">
        <MachinesTile groupId={group.id} items={machines} tickets={groupTickets} onChangeStatus={change.open} />
        <NextTodos todos={groupTodos} today={today} />
        <People group={group} open={[...groupTodos, ...groupTickets]} inside />
        <Lately groupId={group.id} />
      </aside>
      {pin.value && <PinNoteDialog groupId={group.id} onClose={pin.close} />}
      {change.value && <ChangeStatusDialog target={change.value} onClose={change.close} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Outside
// ---------------------------------------------------------------------------------------------------------------

function OutsideOverview({ summary, group }: { summary: WorkingGroupSummary; group: WorkingGroup }) {
  const notes = useQuery(workingGroupNotesOptions(group.id));
  const status = useQuery(workingGroupStatusOptions);
  const machines = machineRows(group, status.data?.items);
  const write = useDialogOpener();
  const rows = [...(notes.data?.items ?? [])]
    .filter((note) => note.public)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((note) => noteRow(note, group, false));
  return (
    <div className="wg-ov">
      <div className="wg-ov-stats">
        <StatTile
          icon={<UserMultiple size={20} aria-hidden />}
          value={group.memberCount}
          label="People"
          rows={group.lead ? [['Group lead', firstName(group.lead)]] : []}
        />
        {summary.openTicketCount !== undefined && (
          <StatTile
            icon={<Document size={20} aria-hidden />}
            value={summary.openTicketCount}
            label="Open tickets"
            rows={[]}
          />
        )}
      </div>
      <div className="wg-ov-main">
        <PinboardTable
          groupId={group.id}
          rows={rows}
          label="Notes from this group"
          sub={group.description || undefined}
          toolbarAction={<Button onClick={() => write.open(true)}>Write a ticket</Button>}
        />
      </div>
      <aside className="wg-ov-side-col" aria-label="Group details">
        <MachinesTile groupId={group.id} items={machines} />
        <People group={group} inside={false} />
        <Lately groupId={group.id} />
      </aside>
      {write.value && <WriteTicketDialog groups={[summary]} initialGroupId={group.id} onClose={write.close} />}
    </div>
  );
}
