import type { ReactNode } from 'react';
import { Button, Link as CarbonLink, ListItem, ProgressBar, Tag, Tile, UnorderedList } from '@carbon/react';
import { Add, ArrowRight, Launch, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroup, WorkingGroupNote, WorkingGroupSummary } from '../../api/generated/models';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { formatDate } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { ChangeStatusDialog, PinNoteDialog, StatusTag } from './StatusParts';
import { WriteTicketDialog } from './TaskDialogs';
import {
  canManageWorkingGroups,
  workingGroupNotesOptions,
  workingGroupOptions,
  workingGroupStatusOptions,
  workingGroupTicketOptions,
  workingGroupTicketsOptions,
  workingGroupTodoOptions,
  workingGroupTodosOptions,
} from './queries';
import { STATUS_WINDOW_DAYS, backAround, taskLink, type StatusTarget } from './statusModel';
import {
  bucketOf,
  dateParts,
  dueHint,
  firstName,
  initials,
  isOpen,
  personName,
  plural,
  ticketTask,
  todayOn,
  todoTask,
  type Task,
} from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import { useNoteRemoval } from './useNoteRemoval';

function isHttps(url: string | undefined): url is string {
  try {
    return url !== undefined && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Working groups → Overview of one group. People inside see the working view, everybody else the public side. */
export function GroupOverview({ summary }: { summary: WorkingGroupSummary }) {
  const currentUser = useCurrentUser();
  const inside = summary.isMember || summary.isLead || canManageWorkingGroups(currentUser);
  const detail = useQuery(workingGroupOptions(summary.id));
  const relation = summary.isLead ? 'You lead this group.' : summary.isMember ? 'You are a member.' : null;
  return (
    <>
      {inside && (summary.description || relation) && (
        <p className="wg-description">{[summary.description, relation].filter(Boolean).join(' ')}</p>
      )}
      <QueryBoundary query={detail} errorMessage="The working group could not be loaded.">
        {(group) =>
          inside ? (
            <InsideOverview summary={summary} group={group} />
          ) : (
            <OutsideOverview summary={summary} group={group} />
          )
        }
      </QueryBoundary>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pinboard table
// ---------------------------------------------------------------------------------------------------------------

type PinKind = 'ticket' | 'todo' | 'overdue' | 'group-note' | 'public-note';

interface PinRow {
  id: string;
  kind: PinKind;
  text: string;
  from: string;
  when: string;
  task?: Task;
  note?: WorkingGroupNote;
}

const PIN_LABEL: Record<PinKind, string> = {
  ticket: 'Unassigned ticket',
  todo: 'Unassigned to-do',
  overdue: 'Overdue to-do',
  'group-note': 'Group note',
  'public-note': 'Public note',
};

function PinTag({ kind }: { kind: PinKind }) {
  switch (kind) {
    case 'ticket':
      return (
        <Tag size="sm" type="blue">
          {PIN_LABEL[kind]}
        </Tag>
      );
    case 'todo':
      return (
        <Tag size="sm" type="cyan">
          {PIN_LABEL[kind]}
        </Tag>
      );
    case 'overdue':
      return (
        <Tag size="sm" type="red">
          {PIN_LABEL[kind]}
        </Tag>
      );
    default:
      return (
        <Tag size="sm" type="outline">
          {PIN_LABEL[kind]}
        </Tag>
      );
  }
}

const noteKind = (note: WorkingGroupNote): PinKind => (note.public ? 'public-note' : 'group-note');
const noteRow = (note: WorkingGroupNote): PinRow => ({
  id: `note:${note.id}`,
  kind: noteKind(note),
  text: note.text,
  from: personName(note.author),
  when: formatDate(note.createdAt),
  note,
});

/** The last three comments of a ticket or to-do, fetched only while the row is on the visible page. */
function RowComments({ task }: { task: Task }) {
  const ticket = useQuery({ ...workingGroupTicketOptions(task.id), enabled: task.kind === 'ticket' });
  const todo = useQuery({ ...workingGroupTodoOptions(task.id), enabled: task.kind === 'todo' });
  const comments = (task.kind === 'ticket' ? ticket.data?.comments : todo.data?.comments) ?? [];
  if (comments.length === 0) return null;
  const earlier = comments.length - 3;
  return (
    <ul className="wg-comments" aria-label={`Comments on ${task.title}`}>
      {earlier > 0 && (
        <li>
          <CarbonLink as={Link} to={taskLink(task)}>
            {earlier} earlier {earlier === 1 ? 'comment' : 'comments'}
          </CarbonLink>
        </li>
      )}
      {comments.slice(-3).map((comment) => (
        <li key={comment.id} className="wg-comment">
          <span className="wg-initials" aria-hidden>
            {initials(comment.author)}
          </span>
          <span>
            <strong>{firstName(comment.author)}</strong> {comment.text}{' '}
            <span className="wg-muted">{formatDate(comment.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PinboardTable({
  groupId,
  rows,
  inside,
  toolbarAction,
}: {
  groupId: string;
  rows: PinRow[];
  inside: boolean;
  toolbarAction: ReactNode;
}) {
  const removal = useNoteRemoval();
  const label = inside ? 'Group pinboard' : 'Notes from this group';
  const columns: Column<PinRow>[] = [
    { key: 'kind', header: 'Kind', render: (row) => <PinTag kind={row.kind} /> },
    {
      key: 'message',
      header: 'Message',
      render: (row) => (
        <>
          <span className="wg-message">{row.text}</span>
          {row.task && row.task.commentCount > 0 && <RowComments task={row.task} />}
        </>
      ),
    },
    { key: 'from', header: 'From', narrow: true, render: (row) => row.from },
    { key: 'when', header: 'When', narrow: true, render: (row) => row.when },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'wg-actions-cell',
      render: (row) => (
        <span className="wg-actions">
          {row.task && (
            <Button
              as={Link}
              to={taskLink(row.task)}
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={ArrowRight}
              iconDescription="Open"
              tooltipPosition="left"
            />
          )}
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
    <div id={removal.frameId} tabIndex={-1} className="wg-focus">
      <DirectoryTable
        id={`wg-pinboard-${groupId}`}
        urlPrefix="pin"
        label={label}
        columns={columns}
        rows={rows}
        totalCount={rows.length}
        searchText={(row) => `${PIN_LABEL[row.kind]} ${row.text} ${row.from}`}
        defaultSort={{ key: '', direction: 'ASC' }}
        pageSizes={[10, 20, 50, 100]}
        toolbarAction={toolbarAction}
        empty={{ title: 'Nothing pinned', description: 'Notes and open items of the group show up here.' }}
      />
      {removal.dialog}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="wg-card" aria-label={title}>
      <header className="wg-card__header">
        <h2 className="wg-card__title">{title}</h2>
        {sub && <p className="wg-card__sub">{sub}</p>}
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------------------------------------------

function SideColumn({
  group,
  todos,
  today,
  onChangeStatus,
}: {
  group: WorkingGroup;
  todos?: Task[];
  today: string;
  onChangeStatus?: (target: StatusTarget) => void;
}) {
  const members = [...group.members].sort(
    (a, b) => Number(b.isLead) - Number(a.isLead) || a.displayName.localeCompare(b.displayName),
  );
  const items = [
    ...[...group.machines].sort(byName).map((machine) => ({ kind: 'machine' as const, ...machine })),
    ...[...group.places].sort(byName).map((place) => ({ kind: 'place' as const, ...place })),
  ];
  const nextTodos = todos
    ?.filter(isOpen)
    .sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''))
    .slice(0, 5);
  return (
    <aside aria-label="Group details" className="wg-side">
      <DetailPanel>
        {nextTodos && (
          <DetailPanelSection title="To-dos">
            {nextTodos.length === 0 ? (
              <p>Nothing open.</p>
            ) : (
              <ul className="wg-todos">
                {nextTodos.map((task) => {
                  const hint = dueHint(task, today);
                  const parts = task.dueOn ? dateParts(task.dueOn) : null;
                  return (
                    <li key={task.key} className="wg-todo">
                      <span className={`wg-date wg-date--${hint?.tone ?? 'plain'}`} aria-hidden>
                        <span className="wg-date__day">{parts?.day}</span>
                        <span>{parts?.month}</span>
                      </span>
                      <span>
                        <CarbonLink as={Link} to={taskLink(task)}>
                          {task.title}
                        </CarbonLink>
                        <span className={`wg-muted${hint ? ` wg-hint--${hint.tone}` : ''}`}>
                          {hint?.text}
                          {task.assignee ? ` · ${firstName(task.assignee)}` : ''}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </DetailPanelSection>
        )}
        <DetailPanelSection title="People">
          {members.length === 0 ? (
            <p>This group has no members.</p>
          ) : (
            <UnorderedList nested={false}>
              {members.map((member) => (
                <ListItem key={member.personId}>
                  {member.displayName}{' '}
                  {member.isLead && (
                    <Tag size="sm" type="purple">
                      Group lead
                    </Tag>
                  )}
                </ListItem>
              ))}
            </UnorderedList>
          )}
        </DetailPanelSection>
        <DetailPanelSection title="Machines and places">
          {items.length === 0 ? (
            <p>This group looks after no machines or places yet.</p>
          ) : (
            <ul className="wg-items">
              {items.map((item) => {
                const until = backAround(item.until);
                return (
                  <li key={item.id} className="wg-item">
                    <span className="wg-item__head">
                      <span className="wg-item__name">{item.name}</span>
                      <StatusTag status={item.status} />
                    </span>
                    {(item.note || until) && (
                      <span className="wg-muted">{[item.note, until].filter(Boolean).join(' · ')}</span>
                    )}
                    {onChangeStatus && (
                      <Button
                        kind="ghost"
                        size="sm"
                        aria-label={`Change status of ${item.name}`}
                        onClick={() =>
                          onChangeStatus({
                            kind: item.kind,
                            id: item.id,
                            groupId: group.id,
                            name: item.name,
                            status: item.status ?? 'ok',
                            note: item.note,
                            until: item.until,
                          })
                        }
                      >
                        Change status
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DetailPanelSection>
        {isHttps(group.chatUrl) && (
          <DetailPanelSection title="Group chat">
            <CarbonLink href={group.chatUrl} target="_blank" rel="noreferrer noopener" renderIcon={Launch}>
              Open the group chat
            </CarbonLink>
          </DetailPanelSection>
        )}
      </DetailPanel>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Inside
// ---------------------------------------------------------------------------------------------------------------

function StatTile({
  label,
  value,
  detail,
  rows,
}: {
  label: string;
  value: number;
  detail?: string;
  rows?: [string, number][];
}) {
  return (
    <Tile className="wg-stat">
      <span className="wg-stat__label">{label}</span>
      <span className="wg-stat__value">{value}</span>
      {detail && <span className="wg-stat__detail">{detail}</span>}
      {rows?.map(([name, count]) => (
        <span key={name} className="wg-stat__row">
          <span>{name}</span>
          <strong>{count}</strong>
        </span>
      ))}
    </Tile>
  );
}

function InsideOverview({ summary, group }: { summary: WorkingGroupSummary; group: WorkingGroup }) {
  const today = todayOn();
  const tickets = useQuery(workingGroupTicketsOptions);
  const todos = useQuery(workingGroupTodosOptions);
  const notes = useQuery(workingGroupNotesOptions(group.id));
  const status = useQuery(workingGroupStatusOptions);
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
  const dueThisWeek = groupTodos.filter((task) => bucketOf(task, today) === 'week');

  const taskRow = (task: Task, kind: PinKind): PinRow => ({
    id: task.key,
    kind,
    text: task.title,
    from: personName(task.author),
    when: kind === 'overdue' ? (dueHint(task, today)?.text ?? formatDate(task.createdAt)) : formatDate(task.createdAt),
    task,
  });
  const rows: PinRow[] = [
    ...unassignedTickets.map((task) => taskRow(task, 'ticket')),
    ...unassignedTodos.map((task) => taskRow(task, 'todo')),
    ...overdueTodos.filter((task) => task.assignee).map((task) => taskRow(task, 'overdue')),
    ...[...(notes.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(noteRow),
  ];

  const machines = (status.data?.items ?? []).filter((item) => item.group.id === group.id);

  return (
    <>
      <div className="wg-layout wg-layout--stats">
        <div className="wg-stats">
          <StatTile
            label="People"
            value={group.memberCount}
            detail={group.lead ? `Lead: ${group.lead.displayName}` : 'No group lead'}
          />
          <StatTile
            label="Open tickets"
            value={summary.openTicketCount ?? groupTickets.length}
            rows={[['Unassigned', unassignedTickets.length]]}
          />
          <StatTile
            label="Open to-dos"
            value={summary.openTodoCount ?? groupTodos.length}
            rows={[
              ['Overdue', overdueTodos.length],
              ['Due this week', dueThisWeek.length],
            ]}
          />
        </div>
        <Tile className="wg-stat wg-stat--machines">
          <span className="wg-stat__label">Machines, last {STATUS_WINDOW_DAYS} days</span>
          {machines.length === 0 ? (
            <span className="wg-muted">No machines or places.</span>
          ) : (
            <ul className="wg-usage">
              {machines.map((item) => (
                <li key={item.id}>
                  <span className="wg-usage__name">{item.name}</span>
                  <ProgressBar
                    className="wg-usage__bar"
                    size="small"
                    hideLabel
                    label={`${item.name}: ${plural(item.daysNotOkLast90, 'day')} of ${STATUS_WINDOW_DAYS} not working`}
                    value={item.daysNotOkLast90}
                    max={STATUS_WINDOW_DAYS}
                  />
                  <StatusTag status={item.status} />
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </div>
      <div className="wg-layout">
        <Card title="Group pinboard">
          <PinboardTable
            groupId={group.id}
            rows={rows}
            inside
            toolbarAction={
              <Button renderIcon={Add} onClick={() => pin.open(true)}>
                Pin a note
              </Button>
            }
          />
        </Card>
        <SideColumn group={group} todos={groupTodos} today={today} onChangeStatus={change.open} />
      </div>
      {pin.value && <PinNoteDialog groupId={group.id} onClose={pin.close} />}
      {change.value && <ChangeStatusDialog target={change.value} onClose={change.close} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Outside
// ---------------------------------------------------------------------------------------------------------------

function OutsideOverview({ summary, group }: { summary: WorkingGroupSummary; group: WorkingGroup }) {
  const notes = useQuery(workingGroupNotesOptions(group.id));
  const write = useDialogOpener();
  const rows = [...(notes.data?.items ?? [])]
    .filter((note) => note.public)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(noteRow);
  return (
    <>
      <div className="wg-layout">
        <Card title="Notes from this group" sub={group.description || undefined}>
          <PinboardTable
            groupId={group.id}
            rows={rows}
            inside={false}
            toolbarAction={<Button onClick={() => write.open(true)}>Write a ticket</Button>}
          />
        </Card>
        <SideColumn group={group} today={todayOn()} />
      </div>
      {write.value && <WriteTicketDialog groups={[summary]} initialGroupId={group.id} onClose={write.close} />}
    </>
  );
}
