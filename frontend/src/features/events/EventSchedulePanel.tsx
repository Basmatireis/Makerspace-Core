import { Add, Location } from '@carbon/icons-react';
import { Button, Checkbox, ComposedModal, ModalBody, ModalFooter, ModalHeader, OverflowMenu, OverflowMenuItem, Select, SelectItem, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { createEventSession, createEventShift, deleteEventSession, deleteEventShift } from '../../api/generated/events/events';
import type { EventSession, EventShift, EventShiftInput } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useLatestCallback } from '../../app/useLatestCallback';
import { SessionEditDialog, ShiftEditDialog } from './EventEditDialogs';
import { MutationError } from './EventPanelError';
import { formatLocalDate, formatTimeRange, statusTagType, toISO } from './format';
import { eventKeys, eventSessionsQueryOptions, eventShiftsQueryOptions } from './queries';

export function EventSchedulePanel({ eventId, canManage, canStaff, archived }: { eventId: string; canManage: boolean; canStaff: boolean; archived: boolean }) {
  const actionButtons = useRef(new Map<string, HTMLElement>());
  const deleteLauncher = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const sessions = useQuery(eventSessionsQueryOptions(eventId));
  const shifts = useQuery(eventShiftsQueryOptions(eventId));
  const [session, setSession] = useState({ name: '', startsAt: '', endsAt: '', location: '', isPublic: false });
  const [shift, setShift] = useState({ name: '', startsAt: '', endsAt: '', isPublic: false, status: 'draft' });
  const [editingSession, setEditingSession] = useState<EventSession | null>(null);
  const [editingShift, setEditingShift] = useState<EventShift | null>(null);
  const [editingSessionDirty, setEditingSessionDirty] = useState(false);
  const [editingShiftDirty, setEditingShiftDirty] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'Session' | 'Shift'; record: EventSession | EventShift; name: string } | null>(null);
  const isDirty = Boolean(editingSessionDirty || editingShiftDirty || (showSessionForm && (session.name || session.startsAt || session.endsAt || session.location || session.isPublic)) || (showShiftForm && (shift.name || shift.startsAt || shift.endsAt || shift.isPublic || shift.status !== 'draft')));
  const guard = useUnsavedChanges({ isDirty, onDiscard: () => { setSession({ name: '', startsAt: '', endsAt: '', location: '', isPublic: false }); setShift({ name: '', startsAt: '', endsAt: '', isPublic: false, status: 'draft' }); setShowSessionForm(false); setShowShiftForm(false); setEditingSession(null); setEditingShift(null); setEditingSessionDirty(false); setEditingShiftDirty(false); } });
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
  const removeSession = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => deleteEventSession(eventId, id, { expectedVersion: version }), onSuccess: async () => { setDeleteTarget(null); await refresh(); } });
  const removeShift = useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => deleteEventShift(eventId, id, { expectedVersion: version }), onSuccess: async () => { setDeleteTarget(null); await refresh(); } });
  const closeSessionForm = useLatestCallback(() => { if (!addSession.isPending) guard.requestDiscard(() => setShowSessionForm(false)); return false; });
  const closeShiftForm = useLatestCallback(() => { if (!addShift.isPending) guard.requestDiscard(() => setShowShiftForm(false)); return false; });
  const grouped = (() => {
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
  })();

  if (sessions.isPending || shifts.isPending) return <InlineLoadingState label="Loading schedule" />;
  return <Stack gap={7}>
    <section className="event-panel-heading"><div><h2>Schedule</h2><p>Sessions define the official range. Shifts remain independent and may overlap or cross midnight.</p></div>{!archived && <div className="button-cluster">{canManage && <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setShowSessionForm(true)}>Add session</Button>}{canStaff && <Button size="sm" renderIcon={Add} onClick={() => setShowShiftForm(true)}>Add shift</Button>}</div>}</section>
    {grouped.map(([date, items]) => <section key={date} className="event-day"><h3>{date}</h3><div className="event-schedule-list">{items.map((item) => <Tile key={`${item.kind}-${item.record.id}`} className="event-schedule-row">
      <div className="event-schedule-time"><strong>{formatTimeRange(item.record.startsAt, item.record.endsAt)}</strong><span>{item.kind}</span></div>
      <div className="event-schedule-marker" aria-hidden="true"><span/></div>
      <div className="event-schedule-content"><div className="event-record__title"><strong>{item.name}</strong><Tag size="sm" type={statusTagType(item.record.status)}>{item.record.status}</Tag>{item.record.isPublic && <Tag size="sm" type="purple">public</Tag>}</div>{item.record.description && <p>{item.record.description}</p>}{item.kind === 'Session' && item.record.location && <p className="event-muted-line"><Location size={16}/>{item.record.location}</p>}{item.kind === 'Shift' && item.record.sessionId && <p className="event-muted-line">Linked to a session</p>}</div>
      {!archived && ((item.kind === 'Session' && canManage) || (item.kind === 'Shift' && canStaff)) && <OverflowMenu ref={(node) => { const key = `${item.kind}-${item.record.id}`; if (node) actionButtons.current.set(key, node); else actionButtons.current.delete(key); }} ariaLabel={`Actions for ${item.name}`} iconDescription={`Actions for ${item.name}`} size="sm" flipped><OverflowMenuItem itemText="Edit" onClick={() => { if (item.kind === 'Session') { setEditingSessionDirty(false); setEditingSession(item.record); } else { setEditingShiftDirty(false); setEditingShift(item.record); } }} /><OverflowMenuItem isDelete itemText="Delete" onClick={() => { deleteLauncher.current = actionButtons.current.get(`${item.kind}-${item.record.id}`) ?? null; setDeleteTarget(item); }} /></OverflowMenu>}
    </Tile>)}</div></section>)}
    {grouped.length === 0 && <p>No sessions or shifts have been scheduled.</p>}
    {showSessionForm && <ComposedModal open={!guard.dialogOpen} onClose={closeSessionForm} size="sm" preventCloseOnClickOutside><ModalHeader title="Add session"/><ModalBody><form id="add-event-session" onSubmit={(e) => { e.preventDefault(); if (!addSession.isPending) addSession.mutate(); }}><Stack gap={5}><MutationError error={addSession.error} /><TextInput id="new-session-name" labelText="Name (optional)" value={session.name} onChange={(e) => setSession({ ...session, name: e.target.value })} /><TextInput id="new-session-location" labelText="Location (optional)" value={session.location} onChange={(e) => setSession({ ...session, location: e.target.value })} /><TextInput id="new-session-start" type="datetime-local" labelText="Starts" required value={session.startsAt} onChange={(e) => setSession({ ...session, startsAt: e.target.value })} /><TextInput id="new-session-end" type="datetime-local" labelText="Ends" required value={session.endsAt} onChange={(e) => setSession({ ...session, endsAt: e.target.value })} /><Checkbox id="new-session-public" labelText="Show publicly" checked={session.isPublic} onChange={(_, data) => setSession({ ...session, isPublic: data.checked })} /></Stack></form></ModalBody><ModalFooter><Button kind="secondary" disabled={addSession.isPending} onClick={closeSessionForm}>Cancel</Button><Button type="submit" form="add-event-session" disabled={!session.startsAt || !session.endsAt || addSession.isPending}>Add session</Button></ModalFooter></ComposedModal>}
    {showShiftForm && <ComposedModal open={!guard.dialogOpen} onClose={closeShiftForm} size="sm" preventCloseOnClickOutside><ModalHeader title="Add shift"/><ModalBody><form id="add-event-shift" onSubmit={(e) => { e.preventDefault(); if (!addShift.isPending) addShift.mutate(); }}><Stack gap={5}><MutationError error={addShift.error} /><TextInput id="new-shift-name" labelText="Name" required value={shift.name} onChange={(e) => setShift({ ...shift, name: e.target.value })} /><TextInput id="new-shift-start" type="datetime-local" labelText="Starts" required value={shift.startsAt} onChange={(e) => setShift({ ...shift, startsAt: e.target.value })} /><TextInput id="new-shift-end" type="datetime-local" labelText="Ends" required value={shift.endsAt} onChange={(e) => setShift({ ...shift, endsAt: e.target.value })} /><Select id="new-shift-status" labelText="Status" value={shift.status} onChange={(e) => setShift({ ...shift, status: e.target.value })}><SelectItem value="draft" text="Draft"/><SelectItem value="open" text="Open"/><SelectItem value="closed" text="Closed"/></Select><Checkbox id="new-shift-public" labelText="Show publicly" checked={shift.isPublic} onChange={(_, data) => setShift({ ...shift, isPublic: data.checked })} /></Stack></form></ModalBody><ModalFooter><Button kind="secondary" disabled={addShift.isPending} onClick={closeShiftForm}>Cancel</Button><Button type="submit" form="add-event-shift" disabled={!shift.name.trim() || !shift.startsAt || !shift.endsAt || addShift.isPending}>Add shift</Button></ModalFooter></ComposedModal>}
    {editingSession && <SessionEditDialog key={`${editingSession.id}-${editingSession.version}`} eventId={eventId} session={editingSession} open={!guard.dialogOpen} onDirtyChange={setEditingSessionDirty} onClose={() => guard.requestDiscard(() => { setEditingSession(null); setEditingSessionDirty(false); })} onSaved={async () => { setEditingSession(null); setEditingSessionDirty(false); return refresh(); }} />}
    {editingShift && <ShiftEditDialog key={`${editingShift.id}-${editingShift.version}`} eventId={eventId} shift={editingShift} sessions={sessions.data?.items ?? []} open={!guard.dialogOpen} onDirtyChange={setEditingShiftDirty} onClose={() => guard.requestDiscard(() => { setEditingShift(null); setEditingShiftDirty(false); })} onSaved={async () => { setEditingShift(null); setEditingShiftDirty(false); return refresh(); }} />}
    <DestructiveActionDialog launcherButtonRef={deleteLauncher} open={Boolean(deleteTarget) && !guard.dialogOpen} title={`Delete ${deleteTarget?.name ?? 'schedule item'}?`} confirmLabel={deleteTarget?.kind === 'Session' ? 'Delete session' : 'Delete shift'} pending={removeSession.isPending || removeShift.isPending} error={String(removeSession.error ?? removeShift.error ?? '') || undefined} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (!deleteTarget) return; const input = { id: deleteTarget.record.id, version: deleteTarget.record.version }; if (deleteTarget.kind === 'Session') removeSession.mutate(input); else removeShift.mutate(input); }}><p>{deleteTarget?.kind === 'Session' ? 'The session is removed from the official programme. Linked shifts stay in the schedule and become independent.' : 'The shift is removed. Existing assignment references may prevent deletion.'}</p></DestructiveActionDialog>
    <UnsavedChangesDialog guard={guard}/>
  </Stack>;
}

