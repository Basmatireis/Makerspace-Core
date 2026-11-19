import { useState } from 'react';
import { Button, Link as CarbonLink, Tag, Tile } from '@carbon/react';
import { ArrowRight, ChevronDown, ChevronUp } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupNote, WorkingGroupStatusItem } from '../../api/generated/models';
import { useCurrentUser } from '../auth/auth';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { ChangeStatusDialog, StatusTag } from './StatusParts';
import {
  canManageWorkingGroups,
  workingGroupNotesOptions,
  workingGroupStatusOptions,
  workingGroupsOptions,
  workingGroupTicketsOptions,
  workingGroupTodosOptions,
} from './queries';
import {
  STATUS_LABEL,
  STATUS_SEVERITY,
  STATUS_WINDOW_DAYS,
  backAround,
  taskLink,
  type StatusTarget,
} from './statusModel';
import {
  bucketOf,
  dueHint,
  formatDate,
  isOpen,
  personName,
  ticketTask,
  todayOn,
  todoTask,
  type Task,
} from './taskModel';
import './workinggroups.scss';

type Row =
  | { id: string; type: 'yours'; task: Task }
  | { id: string; type: 'status'; item: WorkingGroupStatusItem }
  | { id: string; type: 'note'; note: WorkingGroupNote };

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
 * The working-groups part of the dashboard: a pinboard of what needs attention (yours, machines and places that are
 * not ok, notes) and a grid of every machine and place. It loads lazily and shows nothing until its data is there.
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
  const [changing, setChanging] = useState<StatusTarget | null>(null);

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
          <Tag size="sm" type="purple">
            Yours
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
              onClick={() => toggle(row.id)}
            >
              {item.name}
            </Button>
            {(item.note || until) && <span className="wg-muted">{[item.note, until].filter(Boolean).join(' · ')}</span>}
            {open && (
              <dl className="wg-facts">
                <dt>Status since</dt>
                <dd>{item.changedAt ? formatDate(item.changedAt) : 'Not recorded'}</dd>
                <dt>Changed by</dt>
                <dd>{personName(item.changedBy)}</dd>
                <dt>Days not ok, last {STATUS_WINDOW_DAYS}</dt>
                <dd>{item.daysNotOkLast90}</dd>
                {insideGroup(item.group.id) && (
                  <dd className="wg-facts__action">
                    <Button kind="tertiary" size="sm" onClick={() => setChanging(target(item))}>
                      Change status
                    </Button>
                  </dd>
                )}
              </dl>
            )}
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
        if (row.type === 'status') return row.item.group.name;
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
        row.type === 'yours'
          ? row.task.dueOn
            ? formatDate(`${row.task.dueOn}T00:00:00Z`)
            : ''
          : row.type === 'status'
            ? row.item.changedAt
              ? formatDate(row.item.changedAt)
              : ''
            : formatDate(row.note.createdAt),
    },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'wg-actions-cell',
      render: (row) =>
        row.type === 'yours' ? (
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
        ) : null,
    },
  ];

  return (
    <>
      <section className="wg-card" aria-label="Pinboard">
        <header className="wg-card__header">
          <h2 className="wg-card__title">Pinboard</h2>
          <CarbonLink as={Link} to="/working-groups">
            Working groups
          </CarbonLink>
        </header>
        <DirectoryTable
          id="wg-dashboard-pinboard"
          urlPrefix="pb"
          label="Pinboard"
          columns={columns}
          rows={rows}
          totalCount={rows.length}
          searchText={(row) =>
            row.type === 'yours'
              ? `Yours ${row.task.title} ${row.task.groupName}`
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
      </section>
      {items.length > 0 && (
        <section className="wg-all" aria-labelledby="wg-all-title">
          <h2 id="wg-all-title" className="wg-card__title">
            All machines and places
          </h2>
          <ul className="wg-all__grid">
            {items.map((item) => (
              <li key={item.id}>
                <Tile className="wg-all__tile">
                  <span className="wg-item__head">
                    <span className="wg-item__name">{item.name}</span>
                    <StatusTag status={item.status} />
                  </span>
                  <span className="wg-muted">{item.group.name}</span>
                </Tile>
              </li>
            ))}
          </ul>
        </section>
      )}
      {changing && <ChangeStatusDialog target={changing} onClose={() => setChanging(null)} />}
    </>
  );
}
