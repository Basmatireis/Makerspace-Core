import {
  Button, Checkbox, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader,
  NumberInput, Select, SelectItem, Stack, TextArea, TextInput,
} from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  updateEventFile, updateEventSession, updateEventShift, updateEventShiftRequirement,
  updateEventTask, updateEventTaskList,
} from '../../api/generated/events/events';
import type {
  EventFile, EventPersonOption, EventRequirement, EventRole, EventSession, EventShift, EventTask, EventTaskList,
  UpdateEventFileRequest, UpdateEventRequirementRequest, UpdateEventSessionRequest, UpdateEventShiftRequest,
  UpdateEventTaskListRequest, UpdateEventTaskRequest,
} from '../../api/generated/models';
import { instantToZonedDateTimeValue } from '../../app/dateTime';
import { eventMutationMessage } from './errors';
import { toISO } from './format';

type DialogProps = {
  eventId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
};

type SessionValues = {
  name: string;
  location: string;
  description: string;
  startsAt: string;
  endsAt: string;
  isPublic: boolean;
  status: EventSession['status'];
};

export function SessionEditDialog({ eventId, session, onClose, onSaved }: DialogProps & { session: EventSession }) {
  const formId = `edit-event-session-${session.id}`;
  const form = useForm<SessionValues>({
    defaultValues: {
      name: session.name ?? '',
      location: session.location ?? '',
      description: session.description ?? '',
      startsAt: instantToZonedDateTimeValue(session.startsAt),
      endsAt: instantToZonedDateTimeValue(session.endsAt),
      isPublic: session.isPublic,
      status: session.status,
    },
  });
  const mutation = useMutation({
    mutationFn: (value: SessionValues) => updateEventSession(eventId, session.id, {
      name: value.name || null,
      location: value.location || null,
      description: value.description || null,
      startsAt: toISO(value.startsAt),
      endsAt: toISO(value.endsAt),
      isPublic: value.isPublic,
      status: value.status,
      expectedVersion: session.version,
    } satisfies UpdateEventSessionRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit session" />
    <ModalBody hasScrollingContent><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Session not saved" subtitle={eventMutationMessage(mutation.error)} />}
      <Controller name="name" control={form.control} render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name (optional)" />} />
      <Controller name="location" control={form.control} render={({ field }) => <TextInput {...field} id={`${formId}-location`} labelText="Location (optional)" />} />
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />} />
      <Controller name="startsAt" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-starts`} type="datetime-local" labelText="Starts" required />} />
      <Controller name="endsAt" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-ends`} type="datetime-local" labelText="Ends" required />} />
      <Controller name="status" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-status`} labelText="Status"><SelectItem value="scheduled" text="Scheduled"/><SelectItem value="cancelled" text="Cancelled"/></Select>} />
      <Controller name="isPublic" control={form.control} render={({ field }) => <Checkbox id={`${formId}-public`} labelText="Show publicly" checked={field.value} onChange={(_, data) => field.onChange(data.checked)} />} />
    </Stack></form></ModalBody>
    <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}

type ShiftValues = {
  sessionId: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  signupOpensAt: string;
  signupClosesAt: string;
  isPublic: boolean;
  status: EventShift['status'];
};

export function ShiftEditDialog({ eventId, shift, sessions, onClose, onSaved }: DialogProps & { shift: EventShift; sessions: EventSession[] }) {
  const formId = `edit-event-shift-${shift.id}`;
  const form = useForm<ShiftValues>({
    defaultValues: {
      sessionId: shift.sessionId ?? '',
      name: shift.name,
      description: shift.description ?? '',
      startsAt: instantToZonedDateTimeValue(shift.startsAt),
      endsAt: instantToZonedDateTimeValue(shift.endsAt),
      signupOpensAt: shift.signupOpensAt ? instantToZonedDateTimeValue(shift.signupOpensAt) : '',
      signupClosesAt: shift.signupClosesAt ? instantToZonedDateTimeValue(shift.signupClosesAt) : '',
      isPublic: shift.isPublic,
      status: shift.status,
    },
  });
  const mutation = useMutation({
    mutationFn: (value: ShiftValues) => updateEventShift(eventId, shift.id, {
      sessionId: value.sessionId || null,
      name: value.name,
      description: value.description || null,
      startsAt: toISO(value.startsAt),
      endsAt: toISO(value.endsAt),
      signupOpensAt: value.signupOpensAt ? toISO(value.signupOpensAt) : null,
      signupClosesAt: value.signupClosesAt ? toISO(value.signupClosesAt) : null,
      isPublic: value.isPublic,
      status: value.status,
      expectedVersion: shift.version,
    } satisfies UpdateEventShiftRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit shift" />
    <ModalBody hasScrollingContent><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Shift not saved" subtitle={eventMutationMessage(mutation.error)} />}
      <Controller name="name" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name" required />} />
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />} />
      <Controller name="sessionId" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-session`} labelText="Linked session (optional)"><SelectItem value="" text="No linked session"/>{sessions.map((session) => <SelectItem key={session.id} value={session.id} text={session.name ?? 'Official session'}/>)}</Select>} />
      <Controller name="startsAt" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-starts`} type="datetime-local" labelText="Starts" required />} />
      <Controller name="endsAt" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-ends`} type="datetime-local" labelText="Ends" required />} />
      <Controller name="signupOpensAt" control={form.control} render={({ field }) => <TextInput {...field} id={`${formId}-signup-opens`} type="datetime-local" labelText="Signup opens (optional)" />} />
      <Controller name="signupClosesAt" control={form.control} render={({ field }) => <TextInput {...field} id={`${formId}-signup-closes`} type="datetime-local" labelText="Signup closes (optional)" />} />
      <Controller name="status" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-status`} labelText="Status"><SelectItem value="draft" text="Draft"/><SelectItem value="open" text="Open"/><SelectItem value="closed" text="Closed"/><SelectItem value="cancelled" text="Cancelled"/></Select>} />
      <Controller name="isPublic" control={form.control} render={({ field }) => <Checkbox id={`${formId}-public`} labelText="Show publicly" checked={field.value} onChange={(_, data) => field.onChange(data.checked)} />} />
    </Stack></form></ModalBody>
    <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}

type RequirementValues = {
  name: string;
  description: string;
  requiredCount: number;
  eligibilityMode: EventRequirement['eligibilityMode'];
  eligibleRoleIds: string[];
};

export function RequirementEditDialog({ eventId, requirement, roles, onClose, onSaved }: DialogProps & { requirement: EventRequirement; roles: EventRole[] }) {
  const formId = `edit-event-requirement-${requirement.id}`;
  const form = useForm<RequirementValues>({
    defaultValues: {
      name: requirement.name,
      description: requirement.description ?? '',
      requiredCount: requirement.requiredCount,
      eligibilityMode: requirement.eligibilityMode,
      eligibleRoleIds: requirement.eligibleRoleIds,
    },
  });
  const mode = form.watch('eligibilityMode');
  const selectedRoles = form.watch('eligibleRoleIds');
  const mutation = useMutation({
    mutationFn: (value: RequirementValues) => updateEventShiftRequirement(eventId, requirement.shiftId, requirement.id, {
      name: value.name,
      description: value.description || null,
      requiredCount: value.requiredCount,
      eligibilityMode: value.eligibilityMode,
      eligibleRoleIds: value.eligibilityMode === 'roles' ? value.eligibleRoleIds : [],
      expectedVersion: requirement.version,
    } satisfies UpdateEventRequirementRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit requirement" />
    <ModalBody hasScrollingContent><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Requirement not saved" subtitle={eventMutationMessage(mutation.error)} />}
      <Controller name="name" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name" required />} />
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />} />
      <Controller name="requiredCount" control={form.control} rules={{ required: true, min: 1, max: 1000 }} render={({ field }) => <NumberInput id={`${formId}-count`} label="Required people" min={1} max={1000} value={field.value} onChange={(_, data) => field.onChange(Number(data.value))} />} />
      <Controller name="eligibilityMode" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-eligibility`} labelText="Eligibility" onChange={(event) => { field.onChange(event); if (event.target.value === 'anyone') form.setValue('eligibleRoleIds', []); }}><SelectItem value="anyone" text="Anyone"/><SelectItem value="roles" text="Selected roles"/></Select>} />
      {mode === 'roles' && <fieldset><legend>Eligible roles</legend><Stack gap={3}>{roles.map((role) => <Checkbox key={role.id} id={`${formId}-role-${role.id}`} labelText={role.name} checked={selectedRoles.includes(role.id)} onChange={(_, data) => form.setValue('eligibleRoleIds', data.checked ? [...selectedRoles, role.id] : selectedRoles.filter((id) => id !== role.id))} />)}</Stack></fieldset>}
    </Stack></form></ModalBody>
    <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending || (mode === 'roles' && selectedRoles.length === 0)}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}

type TaskValues = {
  taskListId: string;
  title: string;
  description: string;
  status: EventTask['status'];
  priority: EventTask['priority'];
  assigneePersonId: string;
  dueAt: string;
};

export function TaskEditDialog({ eventId, task, lists, people, onClose, onSaved }: DialogProps & { task: EventTask; lists: EventTaskList[]; people: EventPersonOption[] }) {
  const formId = `edit-event-task-${task.id}`;
  const form = useForm<TaskValues>({ defaultValues: {
    taskListId: task.taskListId ?? '', title: task.title, description: task.description ?? '', status: task.status,
    priority: task.priority, assigneePersonId: task.assigneePersonId ?? '', dueAt: task.dueAt ? instantToZonedDateTimeValue(task.dueAt) : '',
  } });
  const mutation = useMutation({
    mutationFn: (value: TaskValues) => updateEventTask(eventId, task.id, {
      taskListId: value.taskListId || null, title: value.title, description: value.description || null,
      status: value.status, priority: value.priority, assigneePersonId: value.assigneePersonId || null,
      dueAt: value.dueAt ? toISO(value.dueAt) : null, sortOrder: task.sortOrder, expectedVersion: task.version,
    } satisfies UpdateEventTaskRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit task"/>
    <ModalBody hasScrollingContent><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Task not saved" subtitle={eventMutationMessage(mutation.error)}/>}
      <Controller name="title" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-title`} labelText="Title" required/>}/>
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)"/>}/>
      <Controller name="taskListId" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-list`} labelText="Task list"><SelectItem value="" text="Ungrouped"/>{lists.map((list) => <SelectItem key={list.id} value={list.id} text={list.name}/>)}</Select>}/>
      <Controller name="assigneePersonId" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-assignee`} labelText="Assignee"><SelectItem value="" text="Unassigned"/>{people.map((person) => <SelectItem key={person.id} value={person.id} text={`${person.firstName} ${person.lastName}`}/>)}</Select>}/>
      <Controller name="status" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-status`} labelText="Status">{['open','in_progress','blocked','done','cancelled'].map((value) => <SelectItem key={value} value={value} text={value.replace('_', ' ')}/>)}</Select>}/>
      <Controller name="priority" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-priority`} labelText="Priority">{['low','normal','high','urgent'].map((value) => <SelectItem key={value} value={value} text={value}/>)}</Select>}/>
      <Controller name="dueAt" control={form.control} render={({ field }) => <TextInput {...field} id={`${formId}-due`} type="datetime-local" labelText="Due (optional)"/>}/>
    </Stack></form></ModalBody>
    <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}

type TaskListValues = { name: string; description: string };

export function TaskListEditDialog({ eventId, list, onClose, onSaved }: DialogProps & { list: EventTaskList }) {
  const formId = `edit-event-task-list-${list.id}`;
  const form = useForm<TaskListValues>({ defaultValues: { name: list.name, description: list.description ?? '' } });
  const mutation = useMutation({
    mutationFn: (value: TaskListValues) => updateEventTaskList(eventId, list.id, {
      name: value.name, description: value.description || null, sortOrder: list.sortOrder, expectedVersion: list.version,
    } satisfies UpdateEventTaskListRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit task list"/><ModalBody><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Task list not saved" subtitle={eventMutationMessage(mutation.error)}/>}
      <Controller name="name" control={form.control} rules={{ required: true }} render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name" required/>}/>
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)"/>}/>
    </Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}

type FileValues = { description: string; visibility: EventFile['visibility']; isBanner: boolean };

export function FileEditDialog({ eventId, file, onClose, onSaved }: DialogProps & { file: EventFile }) {
  const formId = `edit-event-file-${file.id}`;
  const form = useForm<FileValues>({ defaultValues: { description: file.description ?? '', visibility: file.visibility, isBanner: file.isBanner } });
  const isBanner = form.watch('isBanner');
  const mutation = useMutation({
    mutationFn: (value: FileValues) => updateEventFile(eventId, file.id, {
      description: value.description || null, visibility: value.isBanner ? 'public' : value.visibility, isBanner: value.isBanner, expectedVersion: file.version,
    } satisfies UpdateEventFileRequest),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
    <ModalHeader title="Edit file details"/><ModalBody><form id={formId} onSubmit={form.handleSubmit((value) => mutation.mutate(value))}><Stack gap={5}>
      {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="File not saved" subtitle={eventMutationMessage(mutation.error)}/>}
      <TextInput id={`${formId}-name`} labelText="File" value={file.originalFilename} readOnly/>
      <Controller name="description" control={form.control} render={({ field }) => <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)"/>}/>
      <Controller name="visibility" control={form.control} render={({ field }) => <Select {...field} id={`${formId}-visibility`} labelText="Visibility" disabled={isBanner}><SelectItem value="internal" text="Internal"/><SelectItem value="public" text="Public"/></Select>}/>
      <Controller name="isBanner" control={form.control} render={({ field }) => <Checkbox id={`${formId}-banner`} labelText="Use this image as the public Event banner" disabled={!file.contentType.startsWith('image/')} checked={field.value} onChange={(_, data) => { field.onChange(data.checked); if (data.checked) form.setValue('visibility', 'public'); }}/>} />
    </Stack></form></ModalBody><ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} disabled={mutation.isPending}>Save changes</Button></ModalFooter>
  </ComposedModal>;
}
