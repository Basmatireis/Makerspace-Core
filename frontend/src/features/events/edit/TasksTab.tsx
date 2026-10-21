import { Add } from '@carbon/icons-react';
import {
  Button,
  Checkbox,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteEventTask, deleteEventTaskList, updateEventTask } from '../../../api/generated/events/events';
import type { Event, EventTask, EventTaskList } from '../../../api/generated/models';
import { EmptyState, ErrorState, InlineLoadingState } from '../../../app/PageState';
import { SectionHeading, TabToolbar } from '../components/Layout';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { TaskDialog, TaskListDialog } from '../dialogs/TaskDialogs';
import { eventMutationMessage } from '../errors';
import { fmtDate } from '../format';
import { isOverdue } from '../logic';
import { eventTaskListsQueryOptions, eventTasksQueryOptions, invalidateEvents } from '../queries';
import { taskBody } from '../requestBodies';
import { ScrollRegion } from '../components/ScrollRegion';

type Dialog =
  | { kind: 'task'; task?: EventTask; listId?: string | null }
  | { kind: 'list'; list?: EventTaskList }
  | { kind: 'delete-list'; list: EventTaskList }
  | { kind: 'delete-task'; task: EventTask };

/** Checklists per task list with the done checkbox, an Important flag and Mine / Overdue / Show done filters. */
export function TasksTab({ event, now, canManage }: { event: Event; now: number; canManage: boolean }) {
  const client = useQueryClient();
  const [mine, setMine] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showDone, setShowDone] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const listsQuery = useQuery(eventTaskListsQueryOptions(event.id));
  const tasksQuery = useQuery(
    eventTasksQueryOptions(event.id, {
      mine: mine || undefined,
      overdue: overdueOnly || undefined,
      includeDone: showDone,
    }),
  );
  const lists = listsQuery.data?.items ?? [];
  const tasks = tasksQuery.data?.items ?? [];
  const filtering = mine || overdueOnly || !showDone;
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await invalidateEvents(client);
      setDialog(null);
    },
  });
  const failure = change.isError ? eventMutationMessage(change.error) : undefined;
  const close = () => {
    change.reset();
    setDialog(null);
  };
  const groups = [
    ...lists.map((list) => ({ list, tasks: tasks.filter((t) => t.taskListId === list.id) })),
    { list: null as EventTaskList | null, tasks: tasks.filter((t) => !lists.some((l) => l.id === t.taskListId)) },
  ].filter((group) => group.list !== null || group.tasks.length > 0);
  const visibleGroups = groups.filter((group) => !filtering || group.tasks.length > 0);

  const row = (task: EventTask) => {
    const overdue = isOverdue(task, now);
    const done = task.status === 'done';
    return (
      <TableRow key={task.id} className={done ? 'ev-row--done' : undefined}>
        <TableCell className="ev-col-check">
          <Checkbox
            id={`ev-task-${task.id}`}
            labelText={`Done: ${task.title}`}
            hideLabel
            checked={done}
            disabled={!canManage || change.isPending}
            onChange={() =>
              change.mutate(() =>
                updateEventTask(event.id, task.id, taskBody(task, { status: done ? 'open' : 'done' })),
              )
            }
          />
        </TableCell>
        <TableCell>
          <div className="ev-cell-stack">
            <span className="ev-row__name">{task.title}</span>
            {task.description && <span className="ev-secondary">{task.description}</span>}
          </div>
        </TableCell>
        <TableCell>{task.assigneePersonId ? 'Assigned' : <span className="ev-secondary">Unassigned</span>}</TableCell>
        <TableCell>
          {task.dueAt ? (
            <span className={overdue ? 'ev-overdue' : undefined}>
              {fmtDate(task.dueAt)}
              {overdue && ' · Overdue'}
            </span>
          ) : (
            <span className="ev-secondary">—</span>
          )}
        </TableCell>
        <TableCell>
          {task.important ? (
            <Tag size="sm" type="red">
              Important
            </Tag>
          ) : (
            <span className="ev-secondary">—</span>
          )}
        </TableCell>
        <TableCell className="ev-col-actions">
          {canManage && (
            <OverflowMenu flipped size="sm" iconDescription={`Actions for task ${task.title}`}>
              <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ kind: 'task', task })} />
              <OverflowMenuItem
                itemText="Delete"
                isDelete
                hasDivider
                onClick={() => setDialog({ kind: 'delete-task', task })}
              />
            </OverflowMenu>
          )}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="ev-stack ev-tab">
      <TabToolbar
        left={
          <div className="ev-filters">
            <Checkbox id="ev-f-mine" labelText="Mine" checked={mine} onChange={(_, { checked }) => setMine(checked)} />
            <Checkbox
              id="ev-f-overdue"
              labelText="Overdue"
              checked={overdueOnly}
              onChange={(_, { checked }) => setOverdueOnly(checked)}
            />
            <Checkbox
              id="ev-f-done"
              labelText="Show done"
              checked={showDone}
              onChange={(_, { checked }) => setShowDone(checked)}
            />
          </div>
        }
        right={
          canManage && (
            <>
              <Button kind="tertiary" renderIcon={Add} onClick={() => setDialog({ kind: 'list' })}>
                Add list
              </Button>
              <Button renderIcon={Add} onClick={() => setDialog({ kind: 'task' })}>
                Add task
              </Button>
            </>
          )
        }
      />
      {(tasksQuery.isPending || listsQuery.isPending) && <InlineLoadingState label="Loading tasks" />}
      {(tasksQuery.isError || listsQuery.isError) && (
        <ErrorState
          title="Unable to load tasks"
          message="Check the connection and try again."
          onRetry={() => {
            void tasksQuery.refetch();
            void listsQuery.refetch();
          }}
        />
      )}
      {failure && !dialog && <p className="ev-error">{failure}</p>}
      {tasksQuery.isSuccess && listsQuery.isSuccess && visibleGroups.length === 0 && (
        <EmptyState
          title={filtering ? 'No tasks match' : 'No tasks yet'}
          description={
            filtering
              ? 'Change the filters to see more.'
              : 'Tasks keep the planning together: who does what until when.'
          }
        />
      )}
      {visibleGroups.map(({ list, tasks: groupTasks }) => (
        <section key={list?.id ?? 'none'} className="ev-tasklist" aria-label={list ? list.name : 'Other tasks'}>
          <SectionHeading
            title={list ? list.name : 'Other tasks'}
            summary={
              showDone
                ? `${groupTasks.filter((t) => t.status === 'done').length} of ${groupTasks.length} done`
                : `${groupTasks.length} open`
            }
            actions={
              canManage &&
              list && (
                <OverflowMenu flipped size="sm" iconDescription={`Actions for list ${list.name}`}>
                  <OverflowMenuItem itemText="Add task" onClick={() => setDialog({ kind: 'task', listId: list.id })} />
                  <OverflowMenuItem itemText="Rename" onClick={() => setDialog({ kind: 'list', list })} />
                  <OverflowMenuItem
                    itemText="Delete list"
                    isDelete
                    hasDivider
                    onClick={() => setDialog({ kind: 'delete-list', list })}
                  />
                </OverflowMenu>
              )
            }
          />
          {groupTasks.length === 0 ? (
            <p className="ev-secondary">No tasks in this list.</p>
          ) : (
            <ScrollRegion label="Tasks">
              <Table size="md" aria-label={list ? list.name : 'Other tasks'} className="ev-table ev-table--tasks">
                <TableHead>
                  <TableRow>
                    <TableHeader className="ev-col-check">Done</TableHeader>
                    <TableHeader>Task</TableHeader>
                    <TableHeader>Assignee</TableHeader>
                    <TableHeader>Due</TableHeader>
                    <TableHeader>Important</TableHeader>
                    <TableHeader className="ev-col-actions">
                      <span className="cds--visually-hidden">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>{groupTasks.map(row)}</TableBody>
              </Table>
            </ScrollRegion>
          )}
        </section>
      ))}

      {dialog?.kind === 'task' && (
        <TaskDialog event={event} task={dialog.task} listId={dialog.listId} lists={lists} onClose={close} />
      )}
      {dialog?.kind === 'list' && <TaskListDialog event={event} list={dialog.list} onClose={close} />}
      {dialog?.kind === 'delete-list' && (
        <ConfirmDialog
          heading="Delete list"
          label={event.name}
          confirmText="Delete list"
          danger
          pending={change.isPending}
          error={failure}
          onClose={close}
          onConfirm={() =>
            change.mutate(() => deleteEventTaskList(event.id, dialog.list.id, { expectedVersion: dialog.list.version }))
          }
        >
          <p>&ldquo;{dialog.list.name}&rdquo; is deleted. Its tasks are kept and move to &ldquo;Other tasks&rdquo;.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete-task' && (
        <ConfirmDialog
          heading="Delete task"
          label={event.name}
          confirmText="Delete task"
          danger
          pending={change.isPending}
          error={failure}
          onClose={close}
          onConfirm={() =>
            change.mutate(() => deleteEventTask(event.id, dialog.task.id, { expectedVersion: dialog.task.version }))
          }
        >
          <p>&ldquo;{dialog.task.title}&rdquo; is deleted.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
