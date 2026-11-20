import { useState } from 'react';
import { Button, Tag } from '@carbon/react';
import {
  Add,
  CheckmarkFilled,
  ChevronDown,
  ChevronUp,
  ErrorFilled,
  InformationFilled,
  TrashCan,
  WarningAltFilled,
} from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupNote, WorkingGroupStatusItem } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import PinboardSkeleton from './PinboardSkeleton';
import { OpenButton, RowComments } from './RowComments';
import { ChangeStatusDialog, PinNoteDialog, StatusTag } from './StatusParts';
import { WriteTicketDialog } from './TaskDialogs';
import { useDialogOpener } from './useDialogOpener';
import { useNoteRemoval } from './useNoteRemoval';
import {
  canManageWorkingGroups,
  workingGroupNotesOptions,
  workingGroupStatusOptions,
  workingGroupsOptions,
  workingGroupTicketsOptions,
  workingGroupTodosOptions,
} from './queries';
import { STATUS_LABEL, STATUS_SEVERITY, STATUS_WINDOW_DAYS, backAround, type StatusTarget } from './statusModel';
import {
  bucketOf,
  dueHint,
  formatDateOnly,
  isOpen,
  personName,
  ticketTask,
  todayOn,
  todoTask,
  type Task,
} from './taskModel';
import './workinggroups.scss';
import '../dashboard/pinboard.scss';

type Row =
  | { id: string; type: 'yours'; task: Task }
  | { id: string; type: 'status'; item: WorkingGroupStatusItem }
  | { id: string; type: 'note'; note: WorkingGroupNote };

const STATUS_ICON = {
  ok: CheckmarkFilled,
  limited: WarningAltFilled,
  maintenance: InformationFilled,
  out_of_order: ErrorFilled,
} as const;

const notOkFirst = (a: WorkingGroupStatusItem, b: WorkingGroupStatusItem) =>
  STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status] || a.name.localeCompare(b.name);

function noteTag(note: WorkingGroupNote) {
  const label = !note.groupId ? 'Makerspace note' : note.public ? 'Public note' : 'Group note';
  return (
    <Tag size="sm" type="outline">
      {label}
    </Tag>
  );
}

/**
 * The working-groups part of the dashboard: a pinboard of what needs attention (for you, machines and places that are
 * not ok, notes) and, in the same card, every machine and place per group. It loads lazily.
 */
export default function DashboardPinboard() {
  const currentUser = useCurrentUser();
  const me = currentUser.person.id;
  const manage = canManageWorkingGroups(currentUser);
  const groups = useQuery(workingGroupsOptions);
  const status = useQuery(workingGroupStatusOptions);
  const notes = useQuery(workingGroupNotesOptions());
  const tickets = useQuery(workingGroupTicketsOptions);
  const todos = useQuery(workingGroupTodosOptions);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const change = useDialogOpener<StatusTarget>();
  const pin = useDialogOpener();
  const write = useDialogOpener();
  const removal = useNoteRemoval();

  if (groups.isPending || status.isPending || notes.isPending) return <PinboardSkeleton />;
  if (!groups.data || !status.data || !notes.data) return null;
  const today = todayOn();
  const items = [...status.data.items].sort(notOkFirst);
  if (items.length === 0 && notes.data.items.length === 0) return null;

  const insideGroup = (id: string) =>
    manage || groups.data.items.some((group) => group.id === id && (group.isMember || group.isLead));
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const yours = [...(tickets.data?.items ?? []).map(ticketTask), ...(todos.data?.items ?? []).map(todoTask)]
    .filter((task) => isOpen(task) && task.assignee?.personId === me)
    .filter((task) => ['overdue', 'week'].includes(bucketOf(task, today)))
    .sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));
  const rows: Row[] = [
    ...yours.map((task): Row => ({ id: task.key, type: 'yours', task })),
    ...items
      .filter((item) => item.status !== 'ok')
      .map((item): Row => ({ id: `status:${item.id}`, type: 'status', item })),
    ...[...notes.data.items]
      .sort((a, b) => Number(Boolean(a.groupId)) - Number(Boolean(b.groupId)) || b.createdAt.localeCompare(a.createdAt))
      .map((note): Row => ({ id: `note:${note.id}`, type: 'note', note })),
  ];

  const broken = items.filter((item) => item.status !== 'ok').length;
  const grouped = new Map<string, WorkingGroupStatusItem[]>();
  for (const item of items) grouped.set(item.group.name, [...(grouped.get(item.group.name) ?? []), item]);
  const byGroup = [...grouped].sort(([a], [b]) => a.localeCompare(b));

  const target = (item: WorkingGroupStatusItem): StatusTarget => ({
    kind: item.kind,
    id: item.id,
    groupId: item.group.id,
    name: item.name,
    status: item.status,
    note: item.note,
    until: item.until,
  });

  const columns: Column<Row>[] = [
    {
      key: 'kind',
      header: 'Kind',
      render: (row) =>
        row.type === 'yours' ? (
          <Tag size="sm" type="teal">
            For you
          </Tag>
        ) : row.type === 'status' ? (
          <StatusTag status={row.item.status} />
        ) : (
          noteTag(row.note)
        ),
    },
    {
      key: 'message',
      header: 'Message',
      render: (row) => {
        if (row.type === 'yours') {
          const hint = dueHint(row.task, today);
          return (
            <>
              <span className="wg-message">{row.task.title}</span>
              {hint && <span className={`wg-muted wg-hint--${hint.tone}`}>{hint.text}</span>}
              {row.task.commentCount > 0 && <RowComments task={row.task} />}
            </>
          );
        }
        if (row.type === 'note') return <span className="wg-message">{row.note.text}</span>;
        const { item } = row;
        const open = expanded.has(row.id);
        const until = backAround(item.until);
        return (
          <>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={open ? ChevronUp : ChevronDown}
              aria-expanded={open}
              aria-controls={`wg-status-${item.id}`}
              onClick={() => toggle(row.id)}
            >
              {item.name}
            </Button>
            {(item.note || until) && <span className="wg-muted">{[item.note, until].filter(Boolean).join(' · ')}</span>}
            <div id={`wg-status-${item.id}`} hidden={!open}>
              {open && (
                <>
                  <dl className="wg-facts">
                    <dt>Status since</dt>
                    <dd>{item.changedAt ? formatDate(item.changedAt) : 'Not recorded'}</dd>
                    <dt>Changed by</dt>
                    <dd>{personName(item.changedBy)}</dd>
                    <dt>Days not ok, last {STATUS_WINDOW_DAYS}</dt>
                    <dd>{item.daysNotOkLast90}</dd>
                  </dl>
                  {insideGroup(item.group.id) && (
                    <Button kind="tertiary" size="sm" onClick={() => change.open(target(item))}>
                      Change status
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        );
      },
    },
    {
      key: 'from',
      header: 'From',
      narrow: true,
      render: (row) => {
        if (row.type === 'yours') return row.task.groupName;
        if (row.type === 'status')
          return (
            <>
              {row.item.group.name}
              <span className="wg-muted">Workshop status</span>
            </>
          );
        return (
          <>
            {personName(row.note.author)}
            {row.note.groupName && <span className="wg-muted">{row.note.groupName}</span>}
          </>
        );
      },
    },
    {
      key: 'when',
      header: 'When',
      narrow: true,
      render: (row) =>
        row.type === 'yours' ? (
          row.task.dueOn ? (
            formatDateOnly(row.task.dueOn)
          ) : (
            ''
          )
        ) : row.type === 'status' ? (
          row.item.until ? (
            <>
              {formatDateOnly(row.item.until.slice(0, 10))}
              <span className="wg-muted">Expected back</span>
            </>
          ) : (
            'No date yet'
          )
        ) : (
          formatDate(row.note.createdAt)
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'wg-actions-cell',
      render: (row) =>
        row.type === 'note' ? (
          row.note.canDelete ? (
            <Button
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={TrashCan}
              iconDescription="Remove note"
              tooltipPosition="left"
              disabled={removal.pending}
              onClick={() => removal.request(row.note)}
            />
          ) : null
        ) : row.type === 'yours' ? (
          <OpenButton task={row.task} />
        ) : null,
    },
  ];

  return (
    <>
      <section className="db-pb" aria-labelledby="db-pb-title">
        <header className="db-pb__head">
          <div>
            <h2 id="db-pb-title" className="wg-card__title">
              Pinboard
            </h2>
            <p className="wg-muted">
              {broken > 0
                ? `${broken} of ${items.length} machines and places are not fully usable`
                : 'Everything works'}{' '}
              · {notes.data.items.length} {notes.data.items.length === 1 ? 'note' : 'notes'}
            </p>
          </div>
          <div className="db-pb__actions">
            <Button as={Link} to="/working-groups/tasks" kind="ghost">
              All tickets
            </Button>
            {groups.data.items.length > 0 && (
              <Button kind="tertiary" onClick={() => write.open(true)}>
                Write a ticket
              </Button>
            )}
            {manage && (
              <Button renderIcon={Add} onClick={() => pin.open(true)}>
                Pin a note
              </Button>
            )}
          </div>
        </header>
        <div id={removal.frameId} tabIndex={-1} className="wg-focus">
          <DirectoryTable
            id="wg-dashboard-pinboard"
            urlPrefix="pb"
            label="Pinboard"
            columns={columns}
            rows={rows}
            totalCount={rows.length}
            searchText={(row) =>
              row.type === 'yours'
                ? `For you ${row.task.title} ${row.task.groupName}`
                : row.type === 'status'
                  ? `${STATUS_LABEL[row.item.status]} ${row.item.name} ${row.item.note ?? ''} ${row.item.group.name}`
                  : `${row.note.text} ${personName(row.note.author)} ${row.note.groupName ?? ''}`
            }
            defaultSort={{ key: '', direction: 'ASC' }}
            pageSizes={[10, 20, 50, 100]}
            onRowClick={(row) => {
              if (row.type === 'status') toggle(row.id);
            }}
            empty={{ title: 'Nothing pinned', description: 'Everything is working and nothing is pinned.' }}
          />
        </div>
        {items.length > 0 && (
          <div className="db-pb__all">
            <h3 className="db-pb__allhead">
              All machines and places
              <span className="wg-muted">
                {items.length - broken} of {items.length} working
              </span>
            </h3>
            <div className="db-pb__groups">
              {byGroup.map(([groupName, groupItems]) => (
                <section key={groupName} className="db-pb__group" aria-label={groupName}>
                  <h4 className="db-pb__grouphead">
                    {groupName}
                    <span className="wg-muted">
                      {groupItems.filter((item) => item.status === 'ok').length} of {groupItems.length} working
                    </span>
                  </h4>
                  <ul>
                    {groupItems.map((item) => {
                      const Icon = STATUS_ICON[item.status];
                      return (
                        <li key={item.id} className={`db-pb__item db-pb__item--${item.status}`}>
                          <Icon size={16} aria-hidden />
                          <span className="db-pb__name">{item.name}</span>
                          <span className="db-pb__state">{STATUS_LABEL[item.status]}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        )}
      </section>
      {change.value && <ChangeStatusDialog target={change.value} onClose={change.close} />}
      {pin.value && <PinNoteDialog onClose={pin.close} />}
      {write.value && <WriteTicketDialog groups={groups.data.items} initialGroupId="" onClose={write.close} />}
      {removal.dialog}
    </>
  );
}
