import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineNotification, Modal } from '@carbon/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiErrorCode } from '../../api/http-client';
import type { WorkingGroup } from '../../api/generated/models';
import {
  markWorkingGroupTodoDone,
  reopenWorkingGroupTicket,
  updateWorkingGroupTicket,
  updateWorkingGroupTodo,
} from '../../api/generated/working-groups/working-groups';
import { type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { useNotify } from '../../app/toasts';
import { useCurrentUser } from '../auth/auth';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import {
  canManageWorkingGroups,
  orderGroups,
  workingGroupOptions,
  workingGroupsOptions,
  workingGroupTicketsOptions,
  workingGroupTodosOptions,
} from './queries';
import { CloseTicketDialog, EditColumnsDialog, NewTodoDialog, PlanDialog, WriteTicketDialog } from './TaskDialogs';
import { TaskBoard, type BoardTarget } from './TaskBoard';
import { TaskList } from './TaskList';
import { TaskPanel } from './TaskPanel';
import { TaskSummary, type ScopeFilter } from './TaskSummary';
import { TaskToolbar, type TaskView } from './TaskToolbar';
import {
  isMineTask,
  isOpen,
  personName,
  statusOf,
  ticketTask,
  todoTask,
  TICKET_KIND_LABEL,
  todayOn,
  type StatusKey,
  type Task,
} from './taskModel';
import { TASK_CHANGED, useWgMutation } from './useWgMutation';
import './workinggroups.scss';

type Dialog =
  | { type: 'ticket' }
  | { type: 'todo' }
  | { type: 'plan'; task: Task; columnId?: string }
  | { type: 'close'; task: Task }
  | { type: 'columns'; groupId: string };

const ALL = 'all';

/** Working groups → Tickets & to-dos: the combined list or board of tickets and to-dos of one group or of all. */
export function WorkingGroupTasksPage() {
  const currentUser = useCurrentUser();
  const me = currentUser.person.id;
  const manage = canManageWorkingGroups(currentUser);
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const groupsQuery = useQuery(workingGroupsOptions);
  const ticketsQuery = useQuery(workingGroupTicketsOptions);
  const todosQuery = useQuery(workingGroupTodosOptions);
  const groups = useMemo(() => orderGroups(groupsQuery.data?.items ?? []), [groupsQuery.data]);
  const detailQueries = useQueries({
    queries: groups.map((group) => ({ ...workingGroupOptions(group.id), staleTime: 30_000 })),
  });
  const details = new Map<string, WorkingGroup>();
  for (const query of detailQueries) if (query.data) details.set(query.data.id, query.data);

  const [status, setStatus] = useState<StatusKey | null>(null);
  const [scope, setScope] = useState<ScopeFilter>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rowOpener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelFits = useListPanelLayout();

  const today = todayOn();
  const own = groups.filter((group) => group.isMember || group.isLead);
  const requested = params.get('group');
  const groupId =
    requested === ALL
      ? ALL
      : groups.some((group) => group.id === requested)
        ? (requested as string)
        : (own[0]?.id ?? ALL);
  const selectedGroup = groups.find((group) => group.id === groupId);
  const detail = selectedGroup ? details.get(selectedGroup.id) : undefined;
  const insideGroup = (id: string) =>
    manage || groups.some((group) => group.id === id && (group.isMember || group.isLead));
  const insideGroups = groups.filter((group) => insideGroup(group.id));
  const view: TaskView = selectedGroup && params.get('view') === 'board' ? 'board' : 'list';

  const allTasks = useMemo(
    () => [...(ticketsQuery.data?.items ?? []).map(ticketTask), ...(todosQuery.data?.items ?? []).map(todoTask)],
    [ticketsQuery.data, todosQuery.data],
  );
  const scoped = useMemo(
    () => allTasks.filter((task) => groupId === ALL || task.groupId === groupId),
    [allTasks, groupId],
  );

  const kinds = filters.kind ?? [];
  const ticketKinds = filters.ticketKind ?? [];
  const assignees = filters.assignee ?? [];
  const needle = search.trim().toLowerCase();
  const visible = scoped.filter((task) => {
    if (needle && !task.title.toLowerCase().includes(needle)) return false;
    if (kinds.length > 0 && !kinds.includes(task.kind)) return false;
    if (ticketKinds.length > 0 && !(task.ticket && ticketKinds.includes(task.ticket.kind))) return false;
    if (assignees.length > 0 && !(task.assignee && assignees.includes(task.assignee.personId))) return false;
    if (status || scope) {
      if (!isOpen(task)) return false;
      if (status && statusOf(task, today) !== status) return false;
      if (scope === 'unassigned' && task.assignee) return false;
      if (scope === 'mine' && !isMineTask(task, me)) return false;
    }
    return true;
  });

  const people = new Map<string, string>();
  for (const task of scoped) if (task.assignee) people.set(task.assignee.personId, personName(task.assignee));
  const filterCategories: FilterCategory[] = [
    {
      key: 'kind',
      label: 'Kind',
      options: [
        { id: 'ticket', label: 'Ticket' },
        { id: 'todo', label: 'To-do' },
      ],
    },
    {
      key: 'ticketKind',
      label: 'Ticket kind',
      options: Object.entries(TICKET_KIND_LABEL).map(([id, label]) => ({ id, label })),
    },
    {
      key: 'assignee',
      label: 'Assignee',
      options: [...people].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    },
  ];

  const selected = allTasks.find((task) => task.key === selectedKey) ?? null;
  const loaded = ticketsQuery.isSuccess && todosQuery.isSuccess;
  useEffect(() => {
    // The selected item is gone after a refetch (deleted, or no longer visible): focus moves to the list.
    if (loaded && selectedKey !== null && selected === null) {
      setSelectedKey(null);
      listRef.current?.focus();
    }
  }, [loaded, selectedKey, selected]);
  const select = (key: string) => {
    rowOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedKey(key);
  };

  const setParam = (name: string, value: string | null) =>
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        if (value === null) updated.delete(name);
        else updated.set(name, value);
        return updated;
      },
      { replace: true },
    );

  const open = (next: Dialog) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  };
  const closeDialog = () => {
    setDialog(null);
    // The modal unmounts, so focus goes back to the control that opened it.
    window.setTimeout(() => opener.current?.focus(), 0);
  };

  const reopenTicket = useWgMutation((task: Task) => reopenWorkingGroupTicket(task.id));
  const patchTicket = useWgMutation((args: { task: Task; columnId: string }) =>
    updateWorkingGroupTicket(args.task.id, { expectedVersion: args.task.version, columnId: args.columnId }),
  );
  const patchTodo = useWgMutation((args: { task: Task; columnId: string }) =>
    updateWorkingGroupTodo(args.task.id, { expectedVersion: args.task.version, columnId: args.columnId }),
  );
  const doneTodo = useWgMutation((task: Task) => markWorkingGroupTodoDone(task.id));
  const failed = (error: unknown) =>
    notify(
      apiErrorCode(error) === 'working_group_task_state'
        ? { kind: 'warning', title: TASK_CHANGED }
        : { kind: 'error', title: 'Not moved', subtitle: 'Reload the page and try again.' },
    );

  const moveTask = (task: Task, target: BoardTarget) => {
    if (!task.inside) return;
    const onFail = { onError: failed };
    if (target === 'inbox') {
      if (task.kind === 'todo') {
        notify({ kind: 'info', title: 'Not possible', subtitle: 'A to-do cannot go back to the inbox.' });
      } else if (task.state !== 'new') reopenTicket.mutate(task, onFail);
      return;
    }
    if (target === 'done') {
      if (!isOpen(task)) return;
      if (task.kind === 'ticket') open({ type: 'close', task });
      else doneTodo.mutate(task, onFail);
      return;
    }
    if (task.state === 'new') {
      open({ type: 'plan', task, columnId: target });
      return;
    }
    if (task.state !== 'open') {
      notify({ kind: 'info', title: 'Open it again first', subtitle: task.title });
      return;
    }
    if (task.columnId === target) return;
    (task.kind === 'ticket' ? patchTicket : patchTodo).mutate({ task, columnId: target }, onFail);
  };

  if (groupsQuery.isPending || ticketsQuery.isPending || todosQuery.isPending) {
    return (
      <PageShell title="Tickets & to-dos" breadcrumbs={[{ label: 'Working groups', to: '/working-groups' }]}>
        <InlineLoadingState label="Loading tickets and to-dos" />
      </PageShell>
    );
  }
  if (groupsQuery.isError || ticketsQuery.isError || todosQuery.isError) {
    return (
      <PageShell title="Tickets & to-dos" breadcrumbs={[{ label: 'Working groups', to: '/working-groups' }]}>
        <ErrorState title="Tickets and to-dos unavailable" message="Reload the page to try again." />
      </PageShell>
    );
  }
  if (groups.length === 0) {
    return (
      <PageShell title="Tickets & to-dos" breadcrumbs={[{ label: 'Working groups', to: '/working-groups' }]}>
        <EmptyState title="No working groups yet" description="Tickets and to-dos belong to a working group." />
      </PageShell>
    );
  }

  const canWriteTodo = selectedGroup ? insideGroup(selectedGroup.id) : insideGroups.length > 0;
  const todoGroups = selectedGroup ? [selectedGroup] : insideGroups;
  const canEditColumns = Boolean(selectedGroup && (detail?.canEdit ?? false));
  const panel = selected ? (
    <TaskPanel
      key={selected.key}
      task={selected}
      group={details.get(selected.groupId)}
      me={me}
      onPlan={(task) => open({ type: 'plan', task })}
      onAnswer={(task) => open({ type: 'close', task })}
      onGone={() => {
        setSelectedKey(null);
        listRef.current?.focus();
      }}
    />
  ) : (
    <DetailPanel>
      <DetailPanelSection>
        <p className="wg-placeholder__title">Nothing selected</p>
        <p className="wg-muted">Pick a ticket or to-do.</p>
      </DetailPanelSection>
    </DetailPanel>
  );

  return (
    <PageShell
      title="Tickets & to-dos"
      width="wide"
      breadcrumbs={[
        { label: 'Working groups', to: '/working-groups' },
        { label: selectedGroup?.name ?? 'All groups', to: `/working-groups/tasks?group=${groupId}` },
      ]}
      tabs={
        <PageSectionTabs
          label="Working groups"
          sections={[{ id: ALL, label: 'All groups' }, ...groups.map((group) => ({ id: group.id, label: group.name }))]}
          selected={groupId}
          onChange={(id) => {
            setSelectedKey(null);
            setStatus(null);
            setScope(null);
            setFilters({});
            setParam('group', id);
          }}
        />
      }
    >
      <TaskSummary
        tasks={scoped}
        today={today}
        me={me}
        status={status}
        scope={scope}
        onStatus={setStatus}
        onScope={setScope}
      />
      <ListWithPanel panel={panel} panelLabel="Ticket or to-do details">
        <div className="wg-card-list" ref={listRef} tabIndex={-1}>
          <TaskToolbar
            search={search}
            onSearch={setSearch}
            filterCategories={filterCategories}
            filters={filters}
            onFilters={setFilters}
            canWriteTodo={canWriteTodo}
            onWriteTicket={() => open({ type: 'ticket' })}
            onNewTodo={() => open({ type: 'todo' })}
            onEditColumns={
              canEditColumns && selectedGroup ? () => open({ type: 'columns', groupId: selectedGroup.id }) : undefined
            }
            boardAvailable={selectedGroup !== undefined}
            view={view}
            onView={(next) => setParam('view', next === 'board' ? 'board' : null)}
          />
          {ticketsQuery.data?.truncated && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Older closed tickets are not shown."
            />
          )}
          {view === 'board' && detail ? (
            <TaskBoard
              group={detail}
              tasks={visible}
              today={today}
              selectedKey={selectedKey}
              onSelect={select}
              onMove={moveTask}
            />
          ) : (
            <TaskList tasks={visible} today={today} groups={details} selectedKey={selectedKey} onSelect={select} />
          )}
        </div>
      </ListWithPanel>

      {/* Below the panel breakpoint the panel is not part of the layout, so the selection opens it as a dialog. */}
      {!panelFits && selected && (
        <Modal
          open
          passiveModal
          size="md"
          modalHeading={selected.kind === 'ticket' ? 'Ticket' : 'To-do'}
          onRequestClose={() => {
            setSelectedKey(null);
            window.setTimeout(() => rowOpener.current?.focus(), 0);
          }}
        >
          {panel}
        </Modal>
      )}

      {dialog?.type === 'ticket' && (
        <WriteTicketDialog groups={groups} initialGroupId={selectedGroup?.id ?? ''} onClose={closeDialog} />
      )}
      {dialog?.type === 'todo' && (
        <NewTodoDialog groups={todoGroups} initialGroupId={selectedGroup?.id ?? ''} onClose={closeDialog} />
      )}
      {dialog?.type === 'plan' && (
        <PlanDialog task={dialog.task} columnId={dialog.columnId} me={me} onClose={closeDialog} />
      )}
      {dialog?.type === 'close' && <CloseTicketDialog task={dialog.task} onClose={closeDialog} />}
      {dialog?.type === 'columns' && <EditColumnsDialog groupId={dialog.groupId} onClose={closeDialog} />}
    </PageShell>
  );
}
