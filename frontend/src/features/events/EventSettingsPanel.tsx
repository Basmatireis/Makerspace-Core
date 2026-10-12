import { Copy, Launch } from '@carbon/icons-react';
import { ActionableNotification, Button, FileUploaderDropContainer, Select, SelectItem, Stack, Tag, TextArea, TextInput, Tile, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { archiveEvent, cancelEvent, completeEvent, confirmEvent, getGetEventBannerUrl, getUploadEventFileUrl, listEventPeople, publishEvent, removeEventFile, returnEventToDraft, returnEventToPlanning, rotateEventPublicId, startEventPlanning, unpublishEvent, updateEvent } from '../../api/generated/events/events';
import type { Event, EventFile, UpdateEventRequest } from '../../api/generated/models';
import { ApiError, apiFetch } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { MutationError } from './EventPanelError';
import { statusTagType } from './format';
import { eventFilesQueryOptions, eventKeys } from './queries';

const eventBannerTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function EventBannerEditor({ event, disabled, discardVersion, guardDialogOpen, onDirtyChange }: { event: Event; disabled: boolean; discardVersion: number; guardDialogOpen: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const files = useQuery(eventFilesQueryOptions(event.id));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const banner = files.data?.items.find((item) => item.isBanner);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => { onDirtyChange(Boolean(file)); }, [file, onDirtyChange]);
  useEffect(() => { setFile(null); setRemoveOpen(false); }, [discardVersion]);
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
    onSuccess: async () => { setRemoveOpen(false); await refresh(); },
  });
  const currentPreview = preview ?? (event.hasBanner || banner ? `${getGetEventBannerUrl(event.id)}?v=${banner?.version ?? encodeURIComponent(event.updatedAt)}` : null);
  return <section className="event-banner-editor" aria-labelledby="event-banner-title"><div><h4 id="event-banner-title">Event banner</h4><p>Shown as the public-page hero and as a thumbnail in the event list. Banner images are always public.</p></div>
    <MutationError error={upload.error ?? remove.error} title="Banner not saved"/>
    <div className={`event-banner-preview${currentPreview ? '' : ' event-banner-preview--empty'}`}>{currentPreview ? <img src={currentPreview} alt="Event banner preview"/> : <span>No banner selected</span>}{preview && <Tag type="purple">Preview</Tag>}</div>
    {!disabled && <Stack gap={4}><FileUploaderDropContainer id="event-banner-upload" accept={eventBannerTypes} maxFileSize={25 << 20} multiple={false} labelText="Choose or drop a JPEG, PNG, GIF, or WebP image up to 25 MiB" onAddFiles={(_, data) => setFile(data.addedFiles[0] ?? null)}/>{file && <div className="event-banner-actions"><span>{file.name}</span><div className="button-cluster"><Button kind="ghost" size="sm" onClick={() => setFile(null)}>Clear preview</Button><Button size="sm" disabled={upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Uploading…' : banner ? 'Replace banner' : 'Upload banner'}</Button></div></div>}{banner && !file && <Button kind="danger--tertiary" size="sm" disabled={remove.isPending} onClick={() => setRemoveOpen(true)}>Remove banner</Button>}</Stack>}
    <DestructiveActionDialog open={removeOpen && !guardDialogOpen} title="Remove event banner?" confirmLabel="Remove banner" pending={remove.isPending} error={remove.isError ? String(remove.error) : undefined} onClose={() => setRemoveOpen(false)} onConfirm={() => remove.mutate()}><p>The public page and event list will no longer show this image.</p></DestructiveActionDialog>
  </section>;
}

function settingsValue(event: Event): UpdateEventRequest {
  return { name: event.name, internalDescription: event.internalDescription ?? null, location: event.location ?? null, ownerPersonId: event.ownerPersonId ?? null, publicTitle: event.publicTitle ?? null, publicDescription: event.publicDescription ?? null, publicLocation: event.publicLocation ?? null, publicSignupEnabled: event.publicSignupEnabled, expectedVersion: event.version };
}

export function EventSettingsPanel({ event, canManage }: { event: Event; canManage: boolean }) {
  const client = useQueryClient(); const navigate = useNavigate();
  const [value, setValue] = useState<UpdateEventRequest>(() => settingsValue(event));
  const [baseline, setBaseline] = useState<UpdateEventRequest>(() => settingsValue(event));
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [bannerDirty, setBannerDirty] = useState(false);
  const [bannerDiscardVersion, setBannerDiscardVersion] = useState(0);
  const formDirty = JSON.stringify(value) !== JSON.stringify(baseline);
  const isDirty = formDirty || bannerDirty;
  const guard = useUnsavedChanges({ isDirty, onDiscard: () => { setValue(baseline); setBannerDirty(false); setBannerDiscardVersion((current) => current + 1); } });
  const people = useQuery({ queryKey: ['events','people','owner'], queryFn: ({ signal }) => listEventPeople(undefined, { signal }), enabled: canManage });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: eventKeys.detail(event.id) }), client.invalidateQueries({ queryKey: eventKeys.all })]); };
  const save = useMutation({ mutationFn: () => updateEvent(event.id, value), onSuccess: async (next) => { const saved = settingsValue(next); setValue(saved); setBaseline(saved); await refresh(); } });
  const action = useMutation({ mutationFn: async (name: string) => { const request = { expectedVersion: event.version }; switch (name) { case 'start': return startEventPlanning(event.id, request); case 'draft': return returnEventToDraft(event.id, request); case 'confirm': return confirmEvent(event.id, request); case 'planning': return returnEventToPlanning(event.id, request); case 'complete': return completeEvent(event.id, request); case 'cancel': return cancelEvent(event.id, request); case 'archive': return archiveEvent(event.id, request); case 'publish': return publishEvent(event.id, request); case 'unpublish': return unpublishEvent(event.id, request); default: return rotateEventPublicId(event.id, request); } }, onSuccess: async () => { setConfirmAction(null); await refresh(); } });
  useEffect(() => {
    if (!formDirty) {
      const next = settingsValue(event);
      setValue(next);
      setBaseline(next);
    }
  // formDirty intentionally prevents background data from replacing a local draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
  if (!canManage) return <p>You can view this event, but settings require <code>events.manage</code>.</p>;
  const archived = event.status === 'archived';
  const metadataReadOnly = archived || event.status === 'completed' || event.status === 'cancelled';
  const lifecycle: Record<string, Array<[string,string]>> = { draft: [['start','Start planning']], planning: [['draft','Return to draft'],['confirm','Confirm'],['cancel','Cancel']], confirmed: [['planning','Return to planning'],['complete','Complete'],['cancel','Cancel']], completed: [['archive','Archive']], cancelled: [['archive','Archive']], archived: [] };
  const publicUrl = `${window.location.origin}/events/public/${event.publicId}`;
  const versionChanged = formDirty && value.expectedVersion !== event.version;
  const staleSave = save.error instanceof ApiError && save.error.data?.code === 'stale_write';
  const continueWithLatestVersion = () => {
    const latest = settingsValue(event);
    setBaseline(latest);
    setValue((current) => ({ ...current, expectedVersion: event.version }));
    save.reset();
  };
  return <Stack gap={7}><section className="event-panel-heading"><div><h2>Settings</h2><p>Edit internal details, public content, lifecycle, and signup availability.</p></div></section><MutationError error={save.error ?? action.error}/>
    {versionChanged && <ActionableNotification inline kind="warning" lowContrast hideCloseButton title="The event changed while you were editing" subtitle="Your draft is still here. Review the current values, then continue it from the latest event version." actionButtonLabel="Continue draft with latest version" onActionButtonClick={continueWithLatestVersion}/>} 
    {staleSave && !versionChanged && <div className="event-version-recovery"><Button size="sm" kind="tertiary" onClick={() => void refresh()}>Fetch the latest event version</Button></div>}
    <form onSubmit={(e) => { e.preventDefault(); if (!save.isPending && !versionChanged) save.mutate(); }}><div className="event-settings-grid">
      <Tile className="event-settings-card"><Stack gap={5}><div><h3>Event details</h3><p>Visible only to authorized event staff.</p></div><TextInput id="settings-event-name" labelText="Internal name" required disabled={metadataReadOnly} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })}/><TextInput id="settings-event-location" labelText="Internal location" disabled={metadataReadOnly} value={value.location ?? ''} onChange={(e) => setValue({ ...value, location: e.target.value || null })}/><TextArea id="settings-event-description" labelText="Internal description" rows={5} disabled={metadataReadOnly} value={value.internalDescription ?? ''} onChange={(e) => setValue({ ...value, internalDescription: e.target.value || null })}/><Select id="settings-event-owner" labelText="Primary owner" disabled={metadataReadOnly} value={value.ownerPersonId ?? ''} onChange={(e) => setValue({ ...value, ownerPersonId: e.target.value || null })}><SelectItem value="" text="No owner"/>{people.data?.items.map((person) => <SelectItem key={person.id} value={person.id} text={`${person.firstName} ${person.lastName}`}/>)}</Select></Stack></Tile>
      <Tile className="event-settings-card"><Stack gap={5}><div><h3>Public event page</h3><p>Only these fields are shown to public visitors.</p></div><EventBannerEditor event={event} disabled={archived} discardVersion={bannerDiscardVersion} guardDialogOpen={guard.dialogOpen} onDirtyChange={setBannerDirty}/><TextInput id="settings-event-public-title" labelText="Public title" disabled={metadataReadOnly} value={value.publicTitle ?? ''} onChange={(e) => setValue({ ...value, publicTitle: e.target.value || null })}/><TextInput id="settings-event-public-location" labelText="Public location" disabled={metadataReadOnly} value={value.publicLocation ?? ''} onChange={(e) => setValue({ ...value, publicLocation: e.target.value || null })}/><TextArea id="settings-event-public-description" labelText="Public description" rows={5} disabled={metadataReadOnly} value={value.publicDescription ?? ''} onChange={(e) => setValue({ ...value, publicDescription: e.target.value || null })}/><div className="event-signup-setting"><Toggle id="settings-public-signup" labelText="Public signup" labelA="Disabled" labelB="Enabled" disabled={metadataReadOnly} toggled={value.publicSignupEnabled} onToggle={(toggled) => setValue({ ...value, publicSignupEnabled: toggled })}/><p>Before enabling signup, add a public shift in Schedule and at least one requirement for that shift in Staffing.</p></div></Stack></Tile>
    </div><div className="event-settings-save"><Button type="submit" disabled={metadataReadOnly || save.isPending || versionChanged}>{save.isPending ? 'Saving…' : 'Save changes'}</Button></div></form>
    <div className="event-settings-grid"><Tile className="event-settings-card"><Stack gap={5}><div className="event-record__title"><div><h3>Lifecycle</h3><p>Current state: <strong>{event.status}</strong></p></div><Tag type={statusTagType(event.status)}>{event.status}</Tag></div><p>Lifecycle changes control editing and signup effectiveness. Archived events are read-only.</p><div className="button-cluster">{lifecycle[event.status].map(([name,label]) => <Button key={name} kind={name === 'cancel' ? 'danger--tertiary' : 'secondary'} disabled={action.isPending || guard.dialogOpen} onClick={() => guard.requestDiscard(() => name === 'cancel' || name === 'archive' ? setConfirmAction(name) : action.mutate(name))}>{label}</Button>)}</div></Stack></Tile>
      <Tile className="event-settings-card"><Stack gap={5}><div className="event-record__title"><div><h3>Publication</h3><p>{event.isPublic ? 'The public page is visible.' : 'The public page is hidden.'}</p></div><Tag type={event.isPublic ? 'green' : 'gray'}>{event.isPublic ? 'published' : 'unpublished'}</Tag></div><div className="event-public-link"><code>{publicUrl}</code><Button hasIconOnly kind="ghost" size="sm" renderIcon={Copy} iconDescription="Copy public event link" onClick={() => void navigator.clipboard.writeText(publicUrl)}/></div><div className="button-cluster"><Button disabled={archived || (!event.isPublic && metadataReadOnly) || action.isPending || guard.dialogOpen} onClick={() => guard.requestDiscard(() => action.mutate(event.isPublic ? 'unpublish' : 'publish'))}>{event.isPublic ? 'Unpublish' : 'Publish'}</Button><Button kind="ghost" renderIcon={Launch} onClick={() => navigate(`/events/public/${event.publicId}`)}>Open public page</Button><Button kind="danger--tertiary" disabled={metadataReadOnly || action.isPending || guard.dialogOpen} onClick={() => guard.requestDiscard(() => setConfirmAction('rotate'))}>Rotate link</Button></div></Stack></Tile></div>
    <UnsavedChangesDialog guard={guard}/>
    <DestructiveActionDialog open={Boolean(confirmAction) && !guard.dialogOpen} title={confirmAction === 'cancel' ? `Cancel ${event.name}?` : confirmAction === 'archive' ? `Archive ${event.name}?` : 'Rotate public link?'} confirmLabel={confirmAction === 'cancel' ? 'Cancel event' : confirmAction === 'archive' ? 'Archive event' : 'Rotate link'} pending={action.isPending} error={action.isError ? String(action.error) : undefined} onClose={() => setConfirmAction(null)} onConfirm={() => { if (confirmAction && !action.isPending) action.mutate(confirmAction); }}><p>{confirmAction === 'cancel' ? 'The schedule and staffing become read-only, and active signup availability ends.' : confirmAction === 'archive' ? 'The event becomes fully read-only.' : 'The current public link will stop working. Share the new private link with intended visitors.'}</p></DestructiveActionDialog>
  </Stack>;
}

