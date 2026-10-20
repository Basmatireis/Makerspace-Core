import { Add } from '@carbon/icons-react';
import {
  Button,
  Checkbox,
  ComposedModal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  OverflowMenu,
  OverflowMenuItem,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  createEventTask,
  createEventTaskList,
  deleteEventTask,
  deleteEventTaskList,
  listEventPeople,
  updateEventTask,
} from '../../api/generated/events/events';
import type { EventTask, EventTaskInput, EventTaskList } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useLatestCallback } from '../../app/useLatestCallback';
import { TaskListEditDialog } from './EventEditDialogs';
import { TaskEditDialog } from './EventTaskEditDialog';
import { MutationError } from './EventPanelError';
import { formatInstant, statusTagType, toISO } from './format';
import { eventKeys, eventTaskListsQueryOptions, eventTasksQueryOptions } from './queries';

export function EventPlanningPanel({
  eventId,
  canManage,
  archived,
}: {
  eventId: string;
  canManage: boolean;
  archived: boolean;
}) {
  const actionButtons = useRef(new Map<string, HTMLElement>());
  const deleteLauncher = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const lists = useQuery(eventTaskListsQueryOptions(eventId));
  const tasks = useQuery(eventTasksQueryOptions(eventId));
  const people = useQuery({
    queryKey: ['events', 'people', 'tasks'],
    queryFn: ({ signal }) => listEventPeople(undefined, { signal }),
    enabled: canManage,
  });
  const [listName, setListName] = useState('');
  const [task, setTask] = useState({ title: '', taskListId: '', dueAt: '', priority: 'normal' });
  const [selectedListId, setSelectedListId] = useState('all');
  const [showListForm, setShowListForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingTask, setEditingTask] = useState<EventTask | null>(null);
  const [editingList, setEditingList] = useState<EventTaskList | null>(null);
  const [editingTaskDirty, setEditingTaskDirty] = useState(false);
  const [editingListDirty, setEditingListDirty] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'task'; item: EventTask } | { kind: 'list'; item: EventTaskList } | null
  >(null);
  const isDirty = Boolean(
    editingTaskDirty ||
    editingListDirty ||
    (showListForm && listName) ||
    (showTaskForm && (task.title || task.taskListId || task.dueAt || task.priority !== 'normal')),
  );
  const guard = useUnsavedChanges({
    isDirty,
    onDiscard: () => {
      setListName('');
      setTask({ title: '', taskListId: '', dueAt: '', priority: 'normal' });
      setShowListForm(false);
      setShowTaskForm(false);
      setEditingTask(null);
      setEditingList(null);
      setEditingTaskDirty(false);
      setEditingListDirty(false);
    },
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: eventKeys.taskLists(eventId) }),
      client.invalidateQueries({ queryKey: eventKeys.tasks(eventId) }),
      client.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
    ]);
  };
  const addList = useMutation({
    mutationFn: () =>
      createEventTaskList(eventId, {
        name: listName,
        description: null,
        sortOrder: (lists.data?.items.length ?? 0) * 10,
      }),
    onSuccess: async (created) => {
      setListName('');
      setSelectedListId(created.id);
      setShowListForm(false);
      await refresh();
    },
  });
  const addTask = useMutation({
    mutationFn: () =>
      createEventTask(eventId, {
        title: task.title,
        description: null,
        taskListId: task.taskListId || null,
        assigneePersonId: null,
        dueAt: task.dueAt ? toISO(task.dueAt) : null,
        status: 'open',
        priority: task.priority as EventTaskInput['priority'],
        sortOrder: (tasks.data?.items.length ?? 0) * 10,
      }),
    onSuccess: async () => {
      setTask({ title: '', taskListId: '', dueAt: '', priority: 'normal' });
      setShowTaskForm(false);
      await refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (item: EventTask) =>
      updateEventTask(eventId, item.id, {
        taskListId: item.taskListId ?? null,
        title: item.title,
        description: item.description ?? null,
        status: item.status === 'done' ? 'open' : 'done',
        priority: item.priority,
        assigneePersonId: item.assigneePersonId ?? null,
        dueAt: item.dueAt ?? null,
        sortOrder: item.sortOrder,
        expectedVersion: item.version,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (item: EventTask) => deleteEventTask(eventId, item.id, { expectedVersion: item.version }),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
    },
  });
  const removeList = useMutation({
    mutationFn: (item: EventTaskList) => deleteEventTaskList(eventId, item.id, { expectedVersion: item.version }),
    onSuccess: async () => {
      setDeleteTarget(null);
      setSelectedListId('all');
      await refresh();
    },
  });
  const closeListForm = useLatestCallback(() => {
    if (!addList.isPending) guard.requestDiscard(() => setShowListForm(false));
    return false;
  });
  const closeTaskForm = useLatestCallback(() => {
    if (!addTask.isPending) guard.requestDiscard(() => setShowTaskForm(false));
    return false;
  });
  if (lists.isPending || tasks.isPending) return <InlineLoadingState label="Loading planning" />;
  const selectedList = lists.data?.items.find((item) => item.id === selectedListId);
  const visibleTasks = (tasks.data?.items ?? []).filter(
    (item) =>
      selectedListId === 'all' ||
      (selectedListId === 'ungrouped' ? !item.taskListId : item.taskListId === selectedListId),
  );
  const listOptions = [
    { id: 'all', name: 'All tasks' },
    { id: 'ungrouped', name: 'Ungrouped' },
    ...(lists.data?.items ?? []),
  ];
  const personName = (personId?: string | null) => {
    const person = people.data?.items.find((candidate) => candidate.id === personId);
    return person ? `${person.firstName} ${person.lastName}` : 'Unassigned';
  };
  return (
    <Stack gap={7}>
      <section className="event-panel-heading">
        <div>
          <h2>Planning</h2>
          <p>Keep preparation work in structured lists and checklists.</p>
        </div>
        {canManage && !archived && (
          <Button
            renderIcon={Add}
            size="sm"
            onClick={() => {
              setTask((value) => ({
                ...value,
                taskListId: selectedListId === 'all' || selectedListId === 'ungrouped' ? '' : selectedListId,
              }));
              setShowTaskForm(true);
            }}
          >
            Add task
          </Button>
        )}
      </section>
      <MutationError error={addList.error ?? addTask.error ?? toggle.error ?? remove.error ?? removeList.error} />
      <div className="event-planning-layout">
        <aside className="event-task-navigation" aria-label="Task lists">
          <div className="event-task-navigation__heading">
            <h3>Task lists</h3>
            {canManage && !archived && (
              <Button
                hasIconOnly
                kind="ghost"
                size="sm"
                renderIcon={Add}
                iconDescription="Add task list"
                onClick={() => setShowListForm(true)}
              />
            )}
          </div>
          {listOptions.map((list) => {
            const count =
              list.id === 'all'
                ? (tasks.data?.items.length ?? 0)
                : (tasks.data?.items ?? []).filter((item) =>
                    list.id === 'ungrouped' ? !item.taskListId : item.taskListId === list.id,
                  ).length;
            const persistedList = 'version' in list ? (list as EventTaskList) : null;
            return (
              <div
                key={list.id}
                className={`event-task-navigation__item${selectedListId === list.id ? ' event-task-navigation__item--selected' : ''}`}
              >
                <Button type="button" kind="ghost" onClick={() => setSelectedListId(list.id)}>
                  <span>{list.name}</span>
                  <span>{count}</span>
                </Button>
                {persistedList && canManage && !archived && (
                  <OverflowMenu
                    ref={(node) => {
                      if (node) actionButtons.current.set(list.id, node);
                      else actionButtons.current.delete(list.id);
                    }}
                    iconDescription={`Actions for ${list.name}`}
                    size="sm"
                    flipped
                  >
                    <OverflowMenuItem
                      itemText="Edit"
                      onClick={() => {
                        setEditingListDirty(false);
                        setEditingList(persistedList);
                      }}
                    />
                    <OverflowMenuItem
                      isDelete
                      itemText="Delete"
                      onClick={() => {
                        deleteLauncher.current = actionButtons.current.get(list.id) ?? null;
                        setDeleteTarget({ kind: 'list', item: persistedList });
                      }}
                    />
                  </OverflowMenu>
                )}
              </div>
            );
          })}
        </aside>
        <section className="event-task-workspace">
          <div className="event-task-workspace__heading">
            <div>
              <h3>{selectedList?.name ?? (selectedListId === 'ungrouped' ? 'Ungrouped' : 'All tasks')}</h3>
              {selectedList?.description && <p>{selectedList.description}</p>}
            </div>
            <span>
              {visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}
            </span>
          </div>
          {visibleTasks.length > 0 ? (
            <TableContainer>
              <Table size="lg">
                <TableHead>
                  <TableRow>
                    <TableHeader>Done</TableHeader>
                    <TableHeader>Title</TableHeader>
                    <TableHeader>Assignee</TableHeader>
                    <TableHeader>Due date</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Actions</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleTasks.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Checkbox
                          id={`task-${item.id}`}
                          labelText={`Mark ${item.title} complete`}
                          hideLabel
                          checked={item.status === 'done'}
                          disabled={!canManage || archived || toggle.isPending}
                          onChange={() => toggle.mutate(item)}
                        />
                      </TableCell>
                      <TableCell>
                        <strong>{item.title}</strong>
                        {item.description && <p>{item.description}</p>}
                      </TableCell>
                      <TableCell>{personName(item.assigneePersonId)}</TableCell>
                      <TableCell>{item.dueAt ? formatInstant(item.dueAt) : 'No deadline'}</TableCell>
                      <TableCell>
                        <Tag size="sm" type={statusTagType(item.status)}>
                          {item.status.replace('_', ' ')}
                        </Tag>
                      </TableCell>
                      <TableCell>
                        {canManage && !archived && (
                          <OverflowMenu
                            ref={(node) => {
                              if (node) actionButtons.current.set(item.id, node);
                              else actionButtons.current.delete(item.id);
                            }}
                            iconDescription={`Actions for ${item.title}`}
                            size="sm"
                            flipped
                          >
                            <OverflowMenuItem
                              itemText="Edit"
                              onClick={() => {
                                setEditingTaskDirty(false);
                                setEditingTask(item);
                              }}
                            />
                            <OverflowMenuItem
                              isDelete
                              itemText="Delete"
                              onClick={() => {
                                deleteLauncher.current = actionButtons.current.get(item.id) ?? null;
                                setDeleteTarget({ kind: 'task', item });
                              }}
                            />
                          </OverflowMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <div className="empty-state">
              <h3>No tasks in this list</h3>
              <p>Add a task when there is work to track.</p>
            </div>
          )}
        </section>
      </div>
      {showListForm && (
        <ComposedModal open={!guard.dialogOpen} onClose={closeListForm} size="sm" preventCloseOnClickOutside>
          <ModalHeader title="Add task list" />
          <ModalBody>
            <form
              id="add-event-task-list"
              onSubmit={(e) => {
                e.preventDefault();
                if (!addList.isPending) addList.mutate();
              }}
            >
              <Stack gap={5}>
                <MutationError error={addList.error} />
                <TextInput
                  id="new-task-list"
                  labelText="List name"
                  required
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                />
              </Stack>
            </form>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" disabled={addList.isPending} onClick={closeListForm}>
              Cancel
            </Button>
            <Button type="submit" form="add-event-task-list" disabled={!listName.trim() || addList.isPending}>
              Add list
            </Button>
          </ModalFooter>
        </ComposedModal>
      )}
      {showTaskForm && (
        <ComposedModal open={!guard.dialogOpen} onClose={closeTaskForm} size="sm" preventCloseOnClickOutside>
          <ModalHeader title="Add task" />
          <ModalBody>
            <form
              id="add-event-task"
              onSubmit={(e) => {
                e.preventDefault();
                if (!addTask.isPending) addTask.mutate();
              }}
            >
              <Stack gap={5}>
                <MutationError error={addTask.error} />
                <TextInput
                  id="new-task-title"
                  labelText="Task"
                  required
                  value={task.title}
                  onChange={(e) => setTask({ ...task, title: e.target.value })}
                />
                <Select
                  id="new-task-list-choice"
                  labelText="List"
                  value={task.taskListId}
                  onChange={(e) => setTask({ ...task, taskListId: e.target.value })}
                >
                  <SelectItem value="" text="Ungrouped" />
                  {(lists.data?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id} text={item.name} />
                  ))}
                </Select>
                <Select
                  id="new-task-priority"
                  labelText="Priority"
                  value={task.priority}
                  onChange={(e) => setTask({ ...task, priority: e.target.value })}
                >
                  {['low', 'normal', 'high', 'urgent'].map((value) => (
                    <SelectItem key={value} value={value} text={value} />
                  ))}
                </Select>
                <TextInput
                  id="new-task-due"
                  type="datetime-local"
                  labelText="Due (optional)"
                  value={task.dueAt}
                  onChange={(e) => setTask({ ...task, dueAt: e.target.value })}
                />
              </Stack>
            </form>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" disabled={addTask.isPending} onClick={closeTaskForm}>
              Cancel
            </Button>
            <Button type="submit" form="add-event-task" disabled={!task.title.trim() || addTask.isPending}>
              Add task
            </Button>
          </ModalFooter>
        </ComposedModal>
      )}
      {editingTask && (
        <TaskEditDialog
          eventId={eventId}
          task={editingTask}
          lists={lists.data?.items ?? []}
          people={people.data?.items ?? []}
          open={!guard.dialogOpen}
          onDirtyChange={setEditingTaskDirty}
          onClose={() =>
            guard.requestDiscard(() => {
              setEditingTask(null);
              setEditingTaskDirty(false);
            })
          }
          onSaved={async () => {
            setEditingTask(null);
            setEditingTaskDirty(false);
            return refresh();
          }}
        />
      )}
      {editingList && (
        <TaskListEditDialog
          eventId={eventId}
          list={editingList}
          open={!guard.dialogOpen}
          onDirtyChange={setEditingListDirty}
          onClose={() =>
            guard.requestDiscard(() => {
              setEditingList(null);
              setEditingListDirty(false);
            })
          }
          onSaved={async () => {
            setEditingList(null);
            setEditingListDirty(false);
            return refresh();
          }}
        />
      )}
      <DestructiveActionDialog
        launcherButtonRef={deleteLauncher}
        open={Boolean(deleteTarget) && !guard.dialogOpen}
        title={`Delete ${deleteTarget ? (deleteTarget.kind === 'list' ? deleteTarget.item.name : deleteTarget.item.title) : 'item'}?`}
        confirmLabel={deleteTarget?.kind === 'list' ? 'Delete task list' : 'Delete task'}
        pending={remove.isPending || removeList.isPending}
        error={String(remove.error ?? removeList.error ?? '') || undefined}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          if (deleteTarget.kind === 'list') removeList.mutate(deleteTarget.item);
          else remove.mutate(deleteTarget.item);
        }}
      >
        <p>
          {deleteTarget?.kind === 'list'
            ? 'The task list is removed. Its tasks remain available as ungrouped tasks.'
            : 'The task and its completion history are removed from this event.'}
        </p>
      </DestructiveActionDialog>
      <UnsavedChangesDialog guard={guard} />
    </Stack>
  );
}
