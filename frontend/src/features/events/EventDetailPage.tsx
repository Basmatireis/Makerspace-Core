import { Add, Calendar, Copy, Edit, Launch, Location, User } from '@carbon/icons-react';
import {
  Button, Checkbox, ComposedModal, FileUploaderDropContainer, InlineNotification, ModalBody, ModalFooter, ModalHeader,
  OverflowMenu, OverflowMenuItem, Select, SelectItem, Stack, Tab, TabList, TabPanel, TabPanels, Tabs, Tag,
  Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TextArea, TextInput, Tile, Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  archiveEvent, cancelEvent, cancelEventAssignment, completeEvent, confirmEvent,
  createEventAssignment, createEventSession, createEventShift, createEventShiftRequirement,
  createEventTask, createEventTaskList, deleteEventSession, deleteEventShift, deleteEventShiftRequirement,
  deleteEventTask, deleteEventTaskList,
  downloadEventFile, getGetEventBannerUrl, getUploadEventFileUrl, listEventEligibilityRoles, listEventPeople,
  publishEvent, removeEventFile, returnEventToDraft, returnEventToPlanning, rotateEventPublicId,
  startEventPlanning, unpublishEvent, updateEvent, updateEventTask,
} from '../../api/generated/events/events';
import type {
  Event, EventAssignmentInput, EventFile, EventRequirement, EventSession, EventShift, EventShiftInput,
  EventTask, EventTaskInput, EventTaskList, UpdateEventRequest,
} from '../../api/generated/models';
import { apiFetch } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import {
  FileEditDialog, RequirementEditDialog, SessionEditDialog, ShiftEditDialog, TaskEditDialog, TaskListEditDialog,
} from './EventEditDialogs';
import { eventMutationMessage } from './errors';
import { eventRange, formatInstant, formatLocalDate, formatTimeRange, statusTagType, toISO } from './format';
import {
  eventAssignmentsQueryOptions, eventFilesQueryOptions, eventKeys, eventQueryOptions,
  eventSessionsQueryOptions, eventShiftsQueryOptions, eventTaskListsQueryOptions, eventTasksQueryOptions,
  eventRequirementsQueryOptions,
} from './queries';

function MutationError({ error, title = 'Change not saved' }: { error: unknown; title?: string }) {
  return error ? <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={eventMutationMessage(error)} /> : null;
}

function SchedulePanel({ eventId, canManage, canStaff, archived }: { eventId: string; canManage: boolean; canStaff: boolean; archived: boolean }) {
  const client = useQueryClient();
  const sessions = useQuery(eventSessionsQueryOptions(eventId));
  const shifts = useQuery(eventShiftsQueryOptions(eventId));
  const [session, setSession] = useState({ name: '', startsAt: '', endsAt: '', location: '', isPublic: false });
  const [shift, setShift] = useState({ name: '', startsAt: '', endsAt: '', isPublic: false, status: 'draft' });
  const [editingSession, setEditingSession] = useState<EventSession | null>(null);
  const [editingShift, setEditingShift] = useState<EventShift | null>(null);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const refresh = async () => Promise.all([
    client.invalidateQueries({ queryKey: eventKeys.sessions(eventId) }),
    client.invalidateQueries({ queryKey: eventKeys.shifts(eventId) }),
    client.invalidateQueries({ queryKey: eventKeys.detail(eventId) }),
    client.invalidateQueries({ queryKey: eventKeys.all }),
  ]);
  const addSession = useMutation({
    mutationFn: () => createEventSession(eventId, { name: session.name || null, location: session.location || null, description: null, startsAt: toISO(session.startsAt), endsAt: toISO(session.endsAt), isPublic: session.isPublic, status: 'scheduled' }),
    onSuccess: async () => { setSession({ name: '', startsAt: '', endsAt: '', location: '', isPublic: false }); setShowSessionForm(false); await refresh(); },
  });
  const addShift = useMutation({
    mutationFn: () => createEventShift(eventId, { name: shift.name, description: null, startsAt: toISO(shift.startsAt), endsAt: toISO(shift.endsAt), signupOpensAt: null, signupClosesAt: null, sessionId: null, isPublic: shift.isPublic, status: shift.status as EventShiftInput['status'] }),
    onSuccess: async () => { setShift({ name: '', startsAt: '', endsAt: '', isPublic: false, status: 'draft' }); setShowShiftForm(false); await refresh(); },
  });
  const removeSession = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => deleteEventSession(eventId, id, { expectedVersion: version }), onSuccess: refresh });
  const removeShift = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => deleteEventShift(eventId, id, { expectedVersion: version }), onSuccess: refresh });
  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ kind: 'Session'; record: EventSession; name: string } | { kind: 'Shift'; record: EventShift; name: string }>>();
    for (const item of sessions.data?.items ?? []) {
      const key = formatLocalDate(item.startsAt); const values = map.get(key) ?? [];
      values.push({ kind: 'Session', record: item, name: item.name ?? 'Official session' }); map.set(key, values);
    }
    for (const item of shifts.data?.items ?? []) {
      const key = formatLocalDate(item.startsAt); const values = map.get(key) ?? [];
      values.push({ kind: 'Shift', record: item, name: item.name }); map.set(key, values);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => [date, values.sort((a, b) => a.record.startsAt.localeCompare(b.record.startsAt))] as const);
  }, [sessions.data, shifts.data]);

  if (sessions.isPending || shifts.isPending) return <InlineLoadingState label="Loading schedule" />;
  return <Stack gap={7}>
    <section className="event-panel-heading"><div><h2>Schedule</h2><p>Sessions define the official range. Shifts remain independent and may overlap or cross midnight.</p></div>{!archived && <div className="button-cluster">{canManage && <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setShowSessionForm(true)}>Add session</Button>}{canStaff && <Button size="sm" renderIcon={Add} onClick={() => setShowShiftForm(true)}>Add shift</Button>}</div>}</section>
    {grouped.map(([date, items]) => <section key={date} className="event-day"><h3>{date}</h3><div className="event-schedule-list">{items.map((item) => <Tile key={`${item.kind}-${item.record.id}`} className="event-schedule-row">
      <div className="event-schedule-time"><strong>{formatTimeRange(item.record.startsAt, item.record.endsAt)}</strong><span>{item.kind}</span></div>
      <div className="event-schedule-marker" aria-hidden="true"><span/></div>
      <div className="event-schedule-content"><div className="event-record__title"><strong>{item.name}</strong><Tag size="sm" type={statusTagType(item.record.status)}>{item.record.status}</Tag>{item.record.isPublic && <Tag size="sm" type="purple">public</Tag>}</div>{item.record.description && <p>{item.record.description}</p>}{item.kind === 'Session' && item.record.location && <p className="event-muted-line"><Location size={16}/>{item.record.location}</p>}{item.kind === 'Shift' && item.record.sessionId && <p className="event-muted-line">Linked to a session</p>}</div>
      {!archived && ((item.kind === 'Session' && canManage) || (item.kind === 'Shift' && canStaff)) && <OverflowMenu ariaLabel={`Actions for ${item.name}`} iconDescription={`Actions for ${item.name}`} size="sm" flipped><OverflowMenuItem itemText="Edit" onClick={() => item.kind === 'Session' ? setEditingSession(item.record) : setEditingShift(item.record)} /><OverflowMenuItem isDelete itemText="Delete" onClick={() => item.kind === 'Session' ? removeSession.mutate({ id: item.record.id, version: item.record.version }) : removeShift.mutate({ id: item.record.id, version: item.record.version })} /></OverflowMenu>}
    </Tile>)}</div></section>)}
    {grouped.length === 0 && <p>No sessions or shifts have been scheduled.</p>}
    {showSessionForm && <ComposedModal open onClose={() => setShowSessionForm(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Add session"/><ModalBody><form id="add-event-session" onSubmit={(e) => { e.preventDefault(); addSession.mutate(); }}><Stack gap={5}><MutationError error={addSession.error} /><TextInput id="new-session-name" labelText="Name (optional)" value={session.name} onChange={(e) => setSession({ ...session, name: e.target.value })} /><TextInput id="new-session-location" labelText="Location (optional)" value={session.location} onChange={(e) => setSession({ ...session, location: e.target.value })} /><TextInput id="new-session-start" type="datetime-local" labelText="Starts" required value={session.startsAt} onChange={(e) => setSession({ ...session, startsAt: e.target.value })} /><TextInput id="new-session-end" type="datetime-local" labelText="Ends" required value={session.endsAt} onChange={(e) => setSession({ ...session, endsAt: e.target.value })} /><Checkbox id="new-session-public" labelText="Show publicly" checked={session.isPublic} onChange={(_, data) => setSession({ ...session, isPublic: data.checked })} /></Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setShowSessionForm(false)}>Cancel</Button><Button type="submit" form="add-event-session" disabled={!session.startsAt || !session.endsAt || addSession.isPending}>Add session</Button></ModalFooter></ComposedModal>}
    {showShiftForm && <ComposedModal open onClose={() => setShowShiftForm(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Add shift"/><ModalBody><form id="add-event-shift" onSubmit={(e) => { e.preventDefault(); addShift.mutate(); }}><Stack gap={5}><MutationError error={addShift.error} /><TextInput id="new-shift-name" labelText="Name" required value={shift.name} onChange={(e) => setShift({ ...shift, name: e.target.value })} /><TextInput id="new-shift-start" type="datetime-local" labelText="Starts" required value={shift.startsAt} onChange={(e) => setShift({ ...shift, startsAt: e.target.value })} /><TextInput id="new-shift-end" type="datetime-local" labelText="Ends" required value={shift.endsAt} onChange={(e) => setShift({ ...shift, endsAt: e.target.value })} /><Select id="new-shift-status" labelText="Status" value={shift.status} onChange={(e) => setShift({ ...shift, status: e.target.value })}><SelectItem value="draft" text="Draft"/><SelectItem value="open" text="Open"/><SelectItem value="closed" text="Closed"/></Select><Checkbox id="new-shift-public" labelText="Show publicly" checked={shift.isPublic} onChange={(_, data) => setShift({ ...shift, isPublic: data.checked })} /></Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setShowShiftForm(false)}>Cancel</Button><Button type="submit" form="add-event-shift" disabled={!shift.name.trim() || !shift.startsAt || !shift.endsAt || addShift.isPending}>Add shift</Button></ModalFooter></ComposedModal>}
    {editingSession && <SessionEditDialog key={`${editingSession.id}-${editingSession.version}`} eventId={eventId} session={editingSession} onClose={() => setEditingSession(null)} onSaved={refresh} />}
    {editingShift && <ShiftEditDialog key={`${editingShift.id}-${editingShift.version}`} eventId={eventId} shift={editingShift} sessions={sessions.data?.items ?? []} onClose={() => setEditingShift(null)} onSaved={refresh} />}
  </Stack>;
}

function PlanningPanel({ eventId, canManage, archived }: { eventId: string; canManage: boolean; archived: boolean }) {
  const client = useQueryClient();
  const lists = useQuery(eventTaskListsQueryOptions(eventId));
  const tasks = useQuery(eventTasksQueryOptions(eventId));
  const people = useQuery({ queryKey: ['events', 'people', 'tasks'], queryFn: ({ signal }) => listEventPeople(undefined, { signal }), enabled: canManage });
  const [listName, setListName] = useState('');
  const [task, setTask] = useState({ title: '', taskListId: '', dueAt: '', priority: 'normal' });
  const [selectedListId, setSelectedListId] = useState('all');
  const [showListForm, setShowListForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingTask, setEditingTask] = useState<EventTask | null>(null);
  const [editingList, setEditingList] = useState<EventTaskList | null>(null);
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: eventKeys.taskLists(eventId) }), client.invalidateQueries({ queryKey: eventKeys.tasks(eventId) }), client.invalidateQueries({ queryKey: eventKeys.detail(eventId) })]); };
  const addList = useMutation({ mutationFn: () => createEventTaskList(eventId, { name: listName, description: null, sortOrder: (lists.data?.items.length ?? 0) * 10 }), onSuccess: async (created) => { setListName(''); setSelectedListId(created.id); setShowListForm(false); await refresh(); } });
  const addTask = useMutation({ mutationFn: () => createEventTask(eventId, { title: task.title, description: null, taskListId: task.taskListId || null, assigneePersonId: null, dueAt: task.dueAt ? toISO(task.dueAt) : null, status: 'open', priority: task.priority as EventTaskInput['priority'], sortOrder: (tasks.data?.items.length ?? 0) * 10 }), onSuccess: async () => { setTask({ title: '', taskListId: '', dueAt: '', priority: 'normal' }); setShowTaskForm(false); await refresh(); } });
  const toggle = useMutation({ mutationFn: (item: EventTask) => updateEventTask(eventId, item.id, { taskListId: item.taskListId ?? null, title: item.title, description: item.description ?? null, status: item.status === 'done' ? 'open' : 'done', priority: item.priority, assigneePersonId: item.assigneePersonId ?? null, dueAt: item.dueAt ?? null, sortOrder: item.sortOrder, expectedVersion: item.version }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (item: EventTask) => deleteEventTask(eventId, item.id, { expectedVersion: item.version }), onSuccess: refresh });
  const removeList = useMutation({ mutationFn: (item: EventTaskList) => deleteEventTaskList(eventId, item.id, { expectedVersion: item.version }), onSuccess: async () => { setSelectedListId('all'); await refresh(); } });
  if (lists.isPending || tasks.isPending) return <InlineLoadingState label="Loading planning" />;
  const selectedList = lists.data?.items.find((item) => item.id === selectedListId);
  const visibleTasks = (tasks.data?.items ?? []).filter((item) => selectedListId === 'all' || (selectedListId === 'ungrouped' ? !item.taskListId : item.taskListId === selectedListId));
  const listOptions = [{ id: 'all', name: 'All tasks' }, { id: 'ungrouped', name: 'Ungrouped' }, ...(lists.data?.items ?? [])];
  const personName = (personId?: string | null) => {
    const person = people.data?.items.find((candidate) => candidate.id === personId);
    return person ? `${person.firstName} ${person.lastName}` : 'Unassigned';
  };
  return <Stack gap={7}>
    <section className="event-panel-heading"><div><h2>Planning</h2><p>Keep preparation work in structured lists and checklists.</p></div>{canManage && !archived && <Button renderIcon={Add} size="sm" onClick={() => { setTask((value) => ({ ...value, taskListId: selectedListId === 'all' || selectedListId === 'ungrouped' ? '' : selectedListId })); setShowTaskForm(true); }}>Add task</Button>}</section>
    <MutationError error={addList.error ?? addTask.error ?? toggle.error ?? remove.error ?? removeList.error}/>
    <div className="event-planning-layout">
      <aside className="event-task-navigation" aria-label="Task lists"><div className="event-task-navigation__heading"><h3>Task lists</h3>{canManage && !archived && <Button hasIconOnly kind="ghost" size="sm" renderIcon={Add} iconDescription="Add task list" onClick={() => setShowListForm(true)}/>}</div>{listOptions.map((list) => {
        const count = list.id === 'all' ? (tasks.data?.items.length ?? 0) : (tasks.data?.items ?? []).filter((item) => list.id === 'ungrouped' ? !item.taskListId : item.taskListId === list.id).length;
        const persistedList = 'version' in list ? list as EventTaskList : null;
        return <div key={list.id} className={`event-task-navigation__item${selectedListId === list.id ? ' event-task-navigation__item--selected' : ''}`}><button type="button" onClick={() => setSelectedListId(list.id)}><span>{list.name}</span><span>{count}</span></button>{persistedList && canManage && !archived && <OverflowMenu iconDescription={`Actions for ${list.name}`} size="sm" flipped><OverflowMenuItem itemText="Edit" onClick={() => setEditingList(persistedList)}/><OverflowMenuItem isDelete itemText="Delete" onClick={() => removeList.mutate(persistedList)}/></OverflowMenu>}</div>;
      })}</aside>
      <section className="event-task-workspace"><div className="event-task-workspace__heading"><div><h3>{selectedList?.name ?? (selectedListId === 'ungrouped' ? 'Ungrouped' : 'All tasks')}</h3>{selectedList?.description && <p>{selectedList.description}</p>}</div><span>{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}</span></div>
        {visibleTasks.length > 0 ? <TableContainer><Table size="lg"><TableHead><TableRow><TableHeader>Done</TableHeader><TableHeader>Title</TableHeader><TableHeader>Assignee</TableHeader><TableHeader>Due date</TableHeader><TableHeader>Status</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead><TableBody>{visibleTasks.map((item) => <TableRow key={item.id}><TableCell><Checkbox id={`task-${item.id}`} labelText={`Mark ${item.title} complete`} hideLabel checked={item.status === 'done'} disabled={!canManage || archived || toggle.isPending} onChange={() => toggle.mutate(item)}/></TableCell><TableCell><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</TableCell><TableCell>{personName(item.assigneePersonId)}</TableCell><TableCell>{item.dueAt ? formatInstant(item.dueAt) : 'No deadline'}</TableCell><TableCell><Tag size="sm" type={statusTagType(item.status)}>{item.status.replace('_', ' ')}</Tag></TableCell><TableCell>{canManage && !archived && <OverflowMenu iconDescription={`Actions for ${item.title}`} size="sm" flipped><OverflowMenuItem itemText="Edit" onClick={() => setEditingTask(item)}/><OverflowMenuItem isDelete itemText="Delete" onClick={() => remove.mutate(item)}/></OverflowMenu>}</TableCell></TableRow>)}</TableBody></Table></TableContainer> : <div className="empty-state"><h3>No tasks in this list</h3><p>Add a task when there is work to track.</p></div>}
      </section>
    </div>
    {showListForm && <ComposedModal open onClose={() => setShowListForm(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Add task list"/><ModalBody><form id="add-event-task-list" onSubmit={(e) => { e.preventDefault(); addList.mutate(); }}><Stack gap={5}><TextInput id="new-task-list" labelText="List name" required value={listName} onChange={(e) => setListName(e.target.value)}/></Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setShowListForm(false)}>Cancel</Button><Button type="submit" form="add-event-task-list" disabled={!listName.trim() || addList.isPending}>Add list</Button></ModalFooter></ComposedModal>}
    {showTaskForm && <ComposedModal open onClose={() => setShowTaskForm(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Add task"/><ModalBody><form id="add-event-task" onSubmit={(e) => { e.preventDefault(); addTask.mutate(); }}><Stack gap={5}><TextInput id="new-task-title" labelText="Task" required value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })}/><Select id="new-task-list-choice" labelText="List" value={task.taskListId} onChange={(e) => setTask({ ...task, taskListId: e.target.value })}><SelectItem value="" text="Ungrouped"/>{(lists.data?.items ?? []).map((item) => <SelectItem key={item.id} value={item.id} text={item.name}/>)}</Select><Select id="new-task-priority" labelText="Priority" value={task.priority} onChange={(e) => setTask({ ...task, priority: e.target.value })}>{['low','normal','high','urgent'].map((value) => <SelectItem key={value} value={value} text={value}/>)}</Select><TextInput id="new-task-due" type="datetime-local" labelText="Due (optional)" value={task.dueAt} onChange={(e) => setTask({ ...task, dueAt: e.target.value })}/></Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setShowTaskForm(false)}>Cancel</Button><Button type="submit" form="add-event-task" disabled={!task.title.trim() || addTask.isPending}>Add task</Button></ModalFooter></ComposedModal>}
    {editingTask && <TaskEditDialog eventId={eventId} task={editingTask} lists={lists.data?.items ?? []} people={people.data?.items ?? []} onClose={() => setEditingTask(null)} onSaved={refresh}/>} 
    {editingList && <TaskListEditDialog eventId={eventId} list={editingList} onClose={() => setEditingList(null)} onSaved={refresh}/>} 
  </Stack>;
}

function RequirementCard({ eventId, shiftId, canStaff, canAssign, archived }: { eventId: string; shiftId: string; canStaff: boolean; canAssign: boolean; archived: boolean }) {
  const client = useQueryClient();
  const query = useQuery(eventRequirementsQueryOptions(eventId, shiftId));
  const [requirement, setRequirement] = useState({ name: '', requiredCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [] as string[] });
  const [editingRequirement, setEditingRequirement] = useState<EventRequirement | null>(null);
  const [showRequirementForm, setShowRequirementForm] = useState(false);
  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const roles = useQuery({ queryKey: ['events', 'eligibility-roles'], queryFn: ({ signal }) => listEventEligibilityRoles({ signal }), enabled: canStaff });
  const [assignment, setAssignment] = useState({ requirementId: '', firstName: '', lastName: '', email: '', phone: '', personId: '', overrideConflict: false });
  const [peopleSearch, setPeopleSearch] = useState('');
  const people = useQuery({ queryKey: ['events', 'people', peopleSearch], queryFn: ({ signal }) => listEventPeople({ search: peopleSearch || undefined }, { signal }), enabled: canAssign });
  const refresh = async () => Promise.all([client.invalidateQueries({ queryKey: eventKeys.requirements(eventId, shiftId) }), client.invalidateQueries({ queryKey: eventKeys.assignments(eventId) }), client.invalidateQueries({ queryKey: eventKeys.shifts(eventId) }), client.invalidateQueries({ queryKey: eventKeys.detail(eventId) })]);
  const addRequirement = useMutation({ mutationFn: () => createEventShiftRequirement(eventId, shiftId, { name: requirement.name, description: null, requiredCount: requirement.requiredCount, eligibilityMode: requirement.eligibilityMode as EventRequirement['eligibilityMode'], eligibleRoleIds: requirement.eligibleRoleIds }), onSuccess: async (created) => { setRequirement({ name: '', requiredCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [] }); setAssignment((value) => ({ ...value, requirementId: created.id })); setShowRequirementForm(false); await refresh(); } });
  const removeRequirement = useMutation({ mutationFn: (item: EventRequirement) => deleteEventShiftRequirement(eventId, shiftId, item.id, { expectedVersion: item.version }), onSuccess: refresh });
  const addAssignment = useMutation({ mutationFn: () => createEventAssignment(eventId, { shiftId, requirementId: assignment.requirementId, personId: assignment.personId || null, firstName: assignment.personId ? undefined : assignment.firstName, lastName: assignment.personId ? undefined : assignment.lastName, email: assignment.email || null, phone: assignment.phone || null, overrideConflict: assignment.overrideConflict } as EventAssignmentInput), onSuccess: async () => { setAssignment({ requirementId: '', firstName: '', lastName: '', email: '', phone: '', personId: '', overrideConflict: false }); setShowAssignmentForm(false); await refresh(); } });
  if (query.isPending) return <InlineLoadingState label="Loading requirements" />;
  return <Stack gap={5}><div className="event-staffing-actions">{canStaff && !archived && <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setShowRequirementForm((visible) => !visible)}>Add requirement</Button>}{canAssign && !archived && Boolean(query.data?.items.length) && <Button kind="ghost" size="sm" renderIcon={User} onClick={() => setShowAssignmentForm((visible) => !visible)}>Assign helper</Button>}</div><div className="event-requirement-table"><div className="event-requirement-table__header"><span>Requirement</span><span>Required</span><span>Filled</span><span>Eligibility</span><span>Progress</span><span>Actions</span></div>{(query.data?.items ?? []).map((item) => { const percent = Math.min(100, Math.round((item.filledCount / item.requiredCount) * 100)); return <div key={item.id} className="event-requirement-row"><div><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}</div><span>{item.requiredCount}</span><span>{item.filledCount}</span><span>{item.eligibilityMode === 'roles' ? 'Selected roles' : 'Anyone'}</span><progress aria-label={`${item.name} staffing`} max={100} value={percent}/>{canStaff && !archived ? <OverflowMenu ariaLabel={`Actions for ${item.name}`} iconDescription={`Actions for ${item.name}`} size="sm" flipped><OverflowMenuItem itemText="Edit" onClick={() => setEditingRequirement(item)} /><OverflowMenuItem isDelete itemText="Delete" onClick={() => removeRequirement.mutate(item)} /></OverflowMenu> : <span/>}</div>; })}</div>
    <MutationError error={addRequirement.error ?? removeRequirement.error ?? addAssignment.error} title={addAssignment.isError ? 'Assignment unavailable' : 'Requirement not saved'} />
    {showRequirementForm && canStaff && !archived && <Tile className="event-inline-editor"><form onSubmit={(e) => { e.preventDefault(); addRequirement.mutate(); }}><Stack gap={4}><h4>Add requirement</h4><TextInput id={`requirement-name-${shiftId}`} labelText="Name" required value={requirement.name} onChange={(e) => setRequirement({ ...requirement, name: e.target.value })}/><TextInput id={`requirement-count-${shiftId}`} labelText="Required people" type="number" min={1} max={1000} required value={requirement.requiredCount} onChange={(e) => setRequirement({ ...requirement, requiredCount: Number(e.target.value) })}/><Select id={`requirement-mode-${shiftId}`} labelText="Eligibility" value={requirement.eligibilityMode} onChange={(e) => setRequirement({ ...requirement, eligibilityMode: e.target.value, eligibleRoleIds: [] })}><SelectItem value="anyone" text="Anyone"/><SelectItem value="roles" text="Selected roles"/></Select>{requirement.eligibilityMode === 'roles' && <fieldset><legend>Eligible roles</legend><Stack gap={3}>{(roles.data?.items ?? []).map((role) => <Checkbox key={role.id} id={`requirement-role-${shiftId}-${role.id}`} labelText={role.name} checked={requirement.eligibleRoleIds.includes(role.id)} onChange={(_, data) => setRequirement({ ...requirement, eligibleRoleIds: data.checked ? [...requirement.eligibleRoleIds, role.id] : requirement.eligibleRoleIds.filter((id) => id !== role.id) })}/>)}</Stack></fieldset>}<div className="form-actions"><Button type="button" kind="secondary" size="sm" onClick={() => setShowRequirementForm(false)}>Cancel</Button><Button type="submit" size="sm" disabled={!requirement.name.trim() || (requirement.eligibilityMode === 'roles' && !requirement.eligibleRoleIds.length)}>Add requirement</Button></div></Stack></form></Tile>}
    {showAssignmentForm && canAssign && !archived && Boolean(query.data?.items.length) && <Tile className="event-inline-editor"><form onSubmit={(e) => { e.preventDefault(); addAssignment.mutate(); }}><Stack gap={4}><h4>Assign helper</h4><Select id={`assignment-requirement-${shiftId}`} labelText="Requirement" required value={assignment.requirementId} onChange={(e) => setAssignment({ ...assignment, requirementId: e.target.value })}><SelectItem value="" text="Choose a requirement"/>{query.data?.items.map((item) => <SelectItem key={item.id} value={item.id} text={`${item.name} (${item.filledCount}/${item.requiredCount})`}/>)}</Select><TextInput id={`assignment-person-search-${shiftId}`} labelText="Find known Person (optional)" value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)}/><Select id={`assignment-person-${shiftId}`} labelText="Known Person" value={assignment.personId} onChange={(e) => setAssignment({ ...assignment, personId: e.target.value })}><SelectItem value="" text="External helper"/>{(people.data?.items ?? []).map((person) => <SelectItem key={person.id} value={person.id} text={`${person.firstName} ${person.lastName}`}/>)}</Select>{!assignment.personId && <><TextInput id={`assignment-first-${shiftId}`} labelText="First name" required value={assignment.firstName} onChange={(e) => setAssignment({ ...assignment, firstName: e.target.value })}/><TextInput id={`assignment-last-${shiftId}`} labelText="Last name" required value={assignment.lastName} onChange={(e) => setAssignment({ ...assignment, lastName: e.target.value })}/><TextInput id={`assignment-email-${shiftId}`} type="email" labelText="Email" value={assignment.email} onChange={(e) => setAssignment({ ...assignment, email: e.target.value })}/><TextInput id={`assignment-phone-${shiftId}`} type="tel" labelText="Phone" value={assignment.phone} onChange={(e) => setAssignment({ ...assignment, phone: e.target.value })}/></>}<Checkbox id={`assignment-override-${shiftId}`} labelText="Override a scheduling conflict (audited)" checked={assignment.overrideConflict} onChange={(_, data) => setAssignment({ ...assignment, overrideConflict: data.checked })}/><div className="form-actions"><Button type="button" kind="secondary" size="sm" onClick={() => setShowAssignmentForm(false)}>Cancel</Button><Button type="submit" size="sm" disabled={!assignment.requirementId || (!assignment.personId && (!assignment.firstName.trim() || !assignment.lastName.trim() || (!assignment.email.trim() && !assignment.phone.trim())))}>Assign</Button></div></Stack></form></Tile>}
    {editingRequirement && <RequirementEditDialog key={`${editingRequirement.id}-${editingRequirement.version}`} eventId={eventId} requirement={editingRequirement} roles={roles.data?.items ?? []} onClose={() => setEditingRequirement(null)} onSaved={refresh} />}
  </Stack>;
}

function StaffingPanel({ eventId, canStaff, canAssign, archived }: { eventId: string; canStaff: boolean; canAssign: boolean; archived: boolean }) {
  const client = useQueryClient();
  const shifts = useQuery(eventShiftsQueryOptions(eventId));
  const assignments = useQuery(eventAssignmentsQueryOptions(eventId, canStaff || canAssign));
  const cancel = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => cancelEventAssignment(eventId, id, { expectedVersion: version }), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: eventKeys.assignments(eventId) }), client.invalidateQueries({ queryKey: eventKeys.shifts(eventId) }), client.invalidateQueries({ queryKey: eventKeys.detail(eventId) })]); } });
  return <Stack gap={7}><section className="event-panel-heading"><div><h2>Staffing</h2><p>Plan requirements by shift. Identities and contact snapshots are restricted to staffing permissions.</p></div></section>{shifts.isPending && <InlineLoadingState label="Loading staffing"/>}{(shifts.data?.items ?? []).map((shift) => {
    const shiftAssignments = assignments.data?.items.filter((item) => item.shiftId === shift.id) ?? [];
    return <Tile key={shift.id} className="event-shift-card"><Stack gap={5}><div className="event-shift-card__heading"><div><div className="event-record__title"><h3>{shift.name}</h3><Tag type={statusTagType(shift.status)}>{shift.status}</Tag>{shift.isPublic && <Tag type="purple">public</Tag>}</div><p>{formatInstant(shift.startsAt)} – {formatInstant(shift.endsAt)}</p></div><span>{shiftAssignments.filter((item) => item.status === 'active').length} assigned</span></div><RequirementCard eventId={eventId} shiftId={shift.id} canStaff={canStaff} canAssign={canAssign} archived={archived}/>{shiftAssignments.length > 0 && <section className="event-assignments"><h4>Assigned team</h4><div className="event-record-list">{shiftAssignments.map((item) => <div key={item.id} className="event-assignment-row"><div className="event-person-avatar" aria-hidden="true">{item.personalDataErasedAt ? '–' : (item.firstName?.[0] ?? item.lastName?.[0] ?? '?')}</div><div><strong>{item.personalDataErasedAt ? 'Personal data erased' : `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim() || 'Known Person'}</strong><p>{[item.email, item.phone].filter(Boolean).join(' · ') || item.source}</p></div><Tag size="sm" type={item.status === 'active' ? 'green' : 'gray'}>{item.status}</Tag>{canAssign && item.status === 'active' && !archived && <Button kind="danger--ghost" size="sm" onClick={() => cancel.mutate({ id: item.id, version: item.version })}>Cancel</Button>}</div>)}</div></section>}</Stack></Tile>;
  })}{shifts.data?.items.length === 0 && <div className="empty-state"><h3>No shifts yet</h3><p>Add shifts in Schedule before staffing the event.</p></div>}</Stack>;
}

function FilesPanel({ eventId, canManage, archived }: { eventId: string; canManage: boolean; archived: boolean }) {
  const client = useQueryClient(); const query = useQuery(eventFilesQueryOptions(eventId)); const [file, setFile] = useState<File | null>(null); const [visibility, setVisibility] = useState<'internal'|'public'>('internal');
  const [showUpload, setShowUpload] = useState(false); const [editingFile, setEditingFile] = useState<EventFile | null>(null);
  const refresh = async () => client.invalidateQueries({ queryKey: eventKeys.files(eventId) });
  const upload = useMutation({ mutationFn: () => apiFetch(getUploadEventFileUrl(eventId), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file?.name ?? '', 'X-File-Content-Type': file?.type || 'application/octet-stream', 'X-Event-File-Visibility': visibility }, body: file }), onSuccess: async () => { setFile(null); setShowUpload(false); await refresh(); } });
  const remove = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => removeEventFile(eventId, id, { expectedVersion: version }), onSuccess: refresh });
  const download = async (id: string, filename: string) => { const blob = await downloadEventFile(eventId, id); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };
  return <Stack gap={7}><section className="event-panel-heading"><div><h2>Files</h2><p>Documents and images shared with the event team or public visitors.</p></div>{canManage && !archived && <Button renderIcon={Add} size="sm" onClick={() => setShowUpload(true)}>Upload file</Button>}</section><MutationError error={upload.error ?? remove.error}/>{query.isPending && <InlineLoadingState label="Loading files"/>}{query.data?.items.length ? <TableContainer className="event-files-table"><Table size="lg"><TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Type</TableHeader><TableHeader>Visibility</TableHeader><TableHeader>Size</TableHeader><TableHeader>Uploaded</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead><TableBody>{query.data.items.map((item) => <TableRow key={item.id}><TableCell><strong>{item.originalFilename}</strong>{item.isBanner && <Tag size="sm" type="purple">banner</Tag>}{item.description && <p>{item.description}</p>}</TableCell><TableCell>{item.contentType}</TableCell><TableCell><Tag size="sm" type={item.visibility === 'public' ? 'green' : 'gray'}>{item.visibility}</Tag></TableCell><TableCell>{item.sizeBytes >= 1024 * 1024 ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(item.sizeBytes / 1024)} KiB`}</TableCell><TableCell>{formatInstant(item.createdAt)}</TableCell><TableCell><OverflowMenu iconDescription={`Actions for ${item.originalFilename}`} size="sm" flipped><OverflowMenuItem itemText="Download" onClick={() => void download(item.id, item.originalFilename)}/>{canManage && !archived && <OverflowMenuItem itemText="Edit details" onClick={() => setEditingFile(item)}/>} {canManage && !archived && <OverflowMenuItem isDelete itemText="Remove" onClick={() => remove.mutate({ id: item.id, version: item.version })}/>}</OverflowMenu></TableCell></TableRow>)}</TableBody></Table></TableContainer> : !query.isPending && <div className="empty-state"><h3>No files attached</h3><p>Upload internal working files or public visitor resources.</p></div>}
    {showUpload && <ComposedModal open onClose={() => setShowUpload(false)} size="sm" preventCloseOnClickOutside><ModalHeader title="Upload file"/><ModalBody><Stack gap={5}><FileUploaderDropContainer id="event-file-upload" accept={['application/pdf','image/jpeg','image/png','image/gif','image/webp','text/plain','text/csv','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation']} maxFileSize={25 << 20} multiple={false} labelText="Choose or drop an allowed file up to 25 MiB" onAddFiles={(_, data) => setFile(data.addedFiles[0] ?? null)}/><Select id="event-file-visibility" labelText="Visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'internal'|'public')}><SelectItem value="internal" text="Internal"/><SelectItem value="public" text="Public"/></Select></Stack></ModalBody><ModalFooter><Button kind="secondary" onClick={() => setShowUpload(false)}>Cancel</Button><Button disabled={!file || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Uploading…' : 'Upload file'}</Button></ModalFooter></ComposedModal>}
    {editingFile && <FileEditDialog eventId={eventId} file={editingFile} onClose={() => setEditingFile(null)} onSaved={refresh}/>} 
  </Stack>;
}

const eventBannerTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function EventBannerEditor({ event, disabled }: { event: Event; disabled: boolean }) {
  const client = useQueryClient();
  const files = useQuery(eventFilesQueryOptions(event.id));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const banner = files.data?.items.find((item) => item.isBanner);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: eventKeys.files(event.id) }),
      client.invalidateQueries({ queryKey: eventKeys.detail(event.id) }),
      client.invalidateQueries({ queryKey: eventKeys.all }),
      client.invalidateQueries({ queryKey: eventKeys.public(event.publicId) }),
    ]);
  };
  const upload = useMutation({
    mutationFn: () => apiFetch<EventFile>(getUploadEventFileUrl(event.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': file?.name ?? '',
        'X-File-Content-Type': file?.type || 'application/octet-stream',
        'X-Event-File-Visibility': 'public',
        'X-Event-File-Purpose': 'banner',
      },
      body: file,
    }),
    onSuccess: async () => { setFile(null); await refresh(); },
  });
  const remove = useMutation({
    mutationFn: () => banner ? removeEventFile(event.id, banner.id, { expectedVersion: banner.version }) : Promise.resolve(),
    onSuccess: refresh,
  });
  const currentPreview = preview ?? (event.hasBanner || banner ? `${getGetEventBannerUrl(event.id)}?v=${banner?.version ?? encodeURIComponent(event.updatedAt)}` : null);
  return <section className="event-banner-editor" aria-labelledby="event-banner-title"><div><h4 id="event-banner-title">Event banner</h4><p>Shown as the public-page hero and as a thumbnail in the event list. Banner images are always public.</p></div>
    <MutationError error={upload.error ?? remove.error} title="Banner not saved"/>
    <div className={`event-banner-preview${currentPreview ? '' : ' event-banner-preview--empty'}`}>{currentPreview ? <img src={currentPreview} alt="Event banner preview"/> : <span>No banner selected</span>}{preview && <Tag type="purple">Preview</Tag>}</div>
    {!disabled && <Stack gap={4}><FileUploaderDropContainer id="event-banner-upload" accept={eventBannerTypes} maxFileSize={25 << 20} multiple={false} labelText="Choose or drop a JPEG, PNG, GIF, or WebP image up to 25 MiB" onAddFiles={(_, data) => setFile(data.addedFiles[0] ?? null)}/>{file && <div className="event-banner-actions"><span>{file.name}</span><div className="button-cluster"><Button kind="ghost" size="sm" onClick={() => setFile(null)}>Clear preview</Button><Button size="sm" disabled={upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Uploading…' : banner ? 'Replace banner' : 'Upload banner'}</Button></div></div>}{banner && !file && <Button kind="danger--tertiary" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Removing…' : 'Remove banner'}</Button>}</Stack>}
  </section>;
}

function SettingsPanel({ event, canManage }: { event: Event; canManage: boolean }) {
  const client = useQueryClient(); const navigate = useNavigate();
  const [value, setValue] = useState<UpdateEventRequest>({ name: event.name, internalDescription: event.internalDescription ?? null, location: event.location ?? null, ownerPersonId: event.ownerPersonId ?? null, publicTitle: event.publicTitle ?? null, publicDescription: event.publicDescription ?? null, publicLocation: event.publicLocation ?? null, publicSignupEnabled: event.publicSignupEnabled, expectedVersion: event.version });
  const people = useQuery({ queryKey: ['events','people','owner'], queryFn: ({ signal }) => listEventPeople(undefined, { signal }), enabled: canManage });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: eventKeys.detail(event.id) }), client.invalidateQueries({ queryKey: eventKeys.all })]); };
  const save = useMutation({ mutationFn: () => updateEvent(event.id, value), onSuccess: async (next) => { setValue({ name: next.name, internalDescription: next.internalDescription ?? null, location: next.location ?? null, ownerPersonId: next.ownerPersonId ?? null, publicTitle: next.publicTitle ?? null, publicDescription: next.publicDescription ?? null, publicLocation: next.publicLocation ?? null, publicSignupEnabled: next.publicSignupEnabled, expectedVersion: next.version }); await refresh(); } });
  const action = useMutation({ mutationFn: async (name: string) => { const request = { expectedVersion: event.version }; switch (name) { case 'start': return startEventPlanning(event.id, request); case 'draft': return returnEventToDraft(event.id, request); case 'confirm': return confirmEvent(event.id, request); case 'planning': return returnEventToPlanning(event.id, request); case 'complete': return completeEvent(event.id, request); case 'cancel': return cancelEvent(event.id, request); case 'archive': return archiveEvent(event.id, request); case 'publish': return publishEvent(event.id, request); case 'unpublish': return unpublishEvent(event.id, request); default: return rotateEventPublicId(event.id, request); } }, onSuccess: refresh });
  if (!canManage) return <p>You can view this event, but settings require <code>events.manage</code>.</p>;
  const archived = event.status === 'archived';
  const metadataReadOnly = archived || event.status === 'completed' || event.status === 'cancelled';
  const lifecycle: Record<string, Array<[string,string]>> = { draft: [['start','Start planning']], planning: [['draft','Return to draft'],['confirm','Confirm'],['cancel','Cancel']], confirmed: [['planning','Return to planning'],['complete','Complete'],['cancel','Cancel']], completed: [['archive','Archive']], cancelled: [['archive','Archive']], archived: [] };
  const publicUrl = `${window.location.origin}/events/public/${event.publicId}`;
  return <Stack gap={7}><section className="event-panel-heading"><div><h2>Settings</h2><p>Edit internal details, public content, lifecycle, and signup availability.</p></div></section><MutationError error={save.error ?? action.error}/>
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}><div className="event-settings-grid">
      <Tile className="event-settings-card"><Stack gap={5}><div><h3>Event details</h3><p>Visible only to authorized event staff.</p></div><TextInput id="settings-event-name" labelText="Internal name" required disabled={metadataReadOnly} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })}/><TextInput id="settings-event-location" labelText="Internal location" disabled={metadataReadOnly} value={value.location ?? ''} onChange={(e) => setValue({ ...value, location: e.target.value || null })}/><TextArea id="settings-event-description" labelText="Internal description" rows={5} disabled={metadataReadOnly} value={value.internalDescription ?? ''} onChange={(e) => setValue({ ...value, internalDescription: e.target.value || null })}/><Select id="settings-event-owner" labelText="Primary owner" disabled={metadataReadOnly} value={value.ownerPersonId ?? ''} onChange={(e) => setValue({ ...value, ownerPersonId: e.target.value || null })}><SelectItem value="" text="No owner"/>{people.data?.items.map((person) => <SelectItem key={person.id} value={person.id} text={`${person.firstName} ${person.lastName}`}/>)}</Select></Stack></Tile>
      <Tile className="event-settings-card"><Stack gap={5}><div><h3>Public event page</h3><p>Only these fields are shown to public visitors.</p></div><EventBannerEditor event={event} disabled={archived}/><TextInput id="settings-event-public-title" labelText="Public title" disabled={metadataReadOnly} value={value.publicTitle ?? ''} onChange={(e) => setValue({ ...value, publicTitle: e.target.value || null })}/><TextInput id="settings-event-public-location" labelText="Public location" disabled={metadataReadOnly} value={value.publicLocation ?? ''} onChange={(e) => setValue({ ...value, publicLocation: e.target.value || null })}/><TextArea id="settings-event-public-description" labelText="Public description" rows={5} disabled={metadataReadOnly} value={value.publicDescription ?? ''} onChange={(e) => setValue({ ...value, publicDescription: e.target.value || null })}/><div className="event-signup-setting"><Toggle id="settings-public-signup" labelText="Public signup" labelA="Disabled" labelB="Enabled" disabled={metadataReadOnly} toggled={value.publicSignupEnabled} onToggle={(toggled) => setValue({ ...value, publicSignupEnabled: toggled })}/><p>Before enabling signup, add a public shift in Schedule and at least one requirement for that shift in Staffing.</p></div></Stack></Tile>
    </div><div className="event-settings-save"><Button type="submit" disabled={metadataReadOnly || save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button></div></form>
    <div className="event-settings-grid"><Tile className="event-settings-card"><Stack gap={5}><div className="event-record__title"><div><h3>Lifecycle</h3><p>Current state: <strong>{event.status}</strong></p></div><Tag type={statusTagType(event.status)}>{event.status}</Tag></div><p>Lifecycle changes control editing and signup effectiveness. Archived events are read-only.</p><div className="button-cluster">{lifecycle[event.status].map(([name,label]) => <Button key={name} kind={name === 'cancel' ? 'danger--tertiary' : 'secondary'} disabled={action.isPending} onClick={() => action.mutate(name)}>{label}</Button>)}</div></Stack></Tile>
      <Tile className="event-settings-card"><Stack gap={5}><div className="event-record__title"><div><h3>Publication</h3><p>{event.isPublic ? 'The public page is visible.' : 'The public page is hidden.'}</p></div><Tag type={event.isPublic ? 'green' : 'gray'}>{event.isPublic ? 'published' : 'unpublished'}</Tag></div><div className="event-public-link"><code>{publicUrl}</code><Button hasIconOnly kind="ghost" size="sm" renderIcon={Copy} iconDescription="Copy public event link" onClick={() => void navigator.clipboard.writeText(publicUrl)}/></div><div className="button-cluster"><Button disabled={archived || (!event.isPublic && metadataReadOnly) || action.isPending} onClick={() => action.mutate(event.isPublic ? 'unpublish' : 'publish')}>{event.isPublic ? 'Unpublish' : 'Publish'}</Button><Button kind="ghost" renderIcon={Launch} onClick={() => navigate(`/events/public/${event.publicId}`)}>Open public page</Button><Button kind="danger--tertiary" disabled={metadataReadOnly || action.isPending} onClick={() => action.mutate('rotate')}>Rotate link</Button></div></Stack></Tile></div>
  </Stack>;
}

export function EventDetailPage() {
  const { eventId = '' } = useParams(); const navigate = useNavigate(); const currentUser = useCurrentUser(); const query = useQuery(eventQueryOptions(eventId));
  const canManage = hasPermission(currentUser, PermissionId.eventsmanage); const canStaff = hasPermission(currentUser, PermissionId.eventsstaffingmanage); const canAssign = hasPermission(currentUser, PermissionId.eventsassign);
  const [selectedSection, setSelectedSection] = useState(0);
  if (query.isPending) return <PageShell title="Event"><InlineLoadingState label="Loading event"/></PageShell>;
  if (query.isError) return <PageShell title="Event"><ErrorState title="Unable to load event" message="It may not exist or you may no longer have access." onRetry={() => void query.refetch()}/></PageShell>;
  const event = query.data; const archived = event.status === 'archived'; const staffingReadOnly = archived || event.status === 'completed' || event.status === 'cancelled';
  const taskPercent = event.taskTotal > 0 ? Math.round((event.taskCompleted / event.taskTotal) * 100) : 0;
  const staffingPercent = event.requiredCount > 0 ? Math.round((event.filledCount / event.requiredCount) * 100) : 0;
  const publicUrl = `${window.location.origin}/events/public/${event.publicId}`;
  return <PageShell
    title={event.name}
    titleAdornment={<><Tag type={statusTagType(event.status)}>{event.status}</Tag>{event.isPublic && <Tag type="purple">published</Tag>}</>}
    breadcrumbs={[{ label:'Events', to:'/events' }, { label:event.name }]}
    actions={<div className="button-cluster">{event.isPublic && <Button kind="tertiary" renderIcon={Launch} onClick={() => navigate(`/events/public/${event.publicId}`)}>Public view</Button>}{canManage && <Button renderIcon={Edit} onClick={() => setSelectedSection(5)}>Edit event</Button>}</div>}
    width="wide"
    className="event-detail-page"
  >
    <div className="event-detail-summary"><span><Calendar size={20}/>{eventRange(event)}</span><span><Location size={20}/>{event.location ?? 'Location not set'}</span><span><User size={20}/>{event.ownerName ?? 'No owner'}</span></div>
    <Tabs selectedIndex={selectedSection} onChange={({ selectedIndex }) => setSelectedSection(selectedIndex)}>
      <TabList aria-label="Event sections" contained><Tab>Overview</Tab><Tab>Schedule</Tab><Tab>Planning</Tab><Tab>Staffing</Tab><Tab>Files</Tab><Tab>Settings</Tab></TabList>
      <TabPanels>
        <TabPanel><div className="event-overview-grid">
          <Tile className="event-overview-card"><h2>About</h2><p>{event.internalDescription ?? 'No internal description has been added.'}</p><dl><div><dt>Location</dt><dd>{event.location ?? 'Not set'}</dd></div><div><dt>Public description</dt><dd>{event.publicDescription ?? 'Not set'}</dd></div></dl></Tile>
          <Tile className="event-overview-card"><h2>Progress</h2><div className="event-progress-block"><div><strong>Tasks</strong><span>{event.taskCompleted} / {event.taskTotal}</span></div><progress aria-label="Task completion" max={100} value={taskPercent}/><Button kind="ghost" size="sm" onClick={() => setSelectedSection(2)}>Open planning</Button></div><div className="event-progress-block"><div><strong>Staffing</strong><span>{event.filledCount} / {event.requiredCount}</span></div><progress aria-label="Staffing progress" max={100} value={staffingPercent}/><Button kind="ghost" size="sm" onClick={() => setSelectedSection(3)}>Open staffing</Button></div></Tile>
          <Tile className="event-overview-card"><h2>Next up</h2><div className="event-next-item"><Calendar size={20}/><div><strong>Next deadline</strong><p>{formatInstant(event.nextDeadline)}</p></div></div><div className="event-next-item"><Calendar size={20}/><div><strong>Next session or shift</strong><p>{formatInstant(event.nextScheduleAt)}</p></div></div></Tile>
          <Tile className="event-overview-card"><h2>Public information</h2><Tag type={event.publicSignupEnabled ? 'green' : 'gray'}>{event.publicSignupEnabled ? 'Public signup enabled' : 'Public signup disabled'}</Tag><div className="event-public-link"><code>{publicUrl}</code><Button hasIconOnly kind="ghost" size="sm" renderIcon={Copy} iconDescription="Copy public event link" onClick={() => void navigator.clipboard.writeText(publicUrl)}/></div><Button kind="tertiary" size="sm" renderIcon={Launch} onClick={() => navigate(`/events/public/${event.publicId}`)}>Open public view</Button><p>Public visitors see only published content, public sessions, shifts, staffing counts, and public files.</p></Tile>
        </div></TabPanel>
        <TabPanel><SchedulePanel eventId={eventId} canManage={canManage} canStaff={canStaff} archived={staffingReadOnly}/></TabPanel>
        <TabPanel><PlanningPanel eventId={eventId} canManage={canManage} archived={archived}/></TabPanel>
        <TabPanel><StaffingPanel eventId={eventId} canStaff={canStaff} canAssign={canAssign} archived={staffingReadOnly}/></TabPanel>
        <TabPanel><FilesPanel eventId={eventId} canManage={canManage} archived={archived}/></TabPanel>
        <TabPanel><SettingsPanel key={event.version} event={event} canManage={canManage}/></TabPanel>
      </TabPanels>
    </Tabs>
  </PageShell>;
}
