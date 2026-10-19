import { useMemo, useState } from 'react';
import { InlineNotification, Modal, MultiSelect, RadioButton, RadioButtonGroup, Select, SelectItem, Stack } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import type { SignageAnnouncement, SignageDisplay } from '../../api/generated/models';
import { startSignageAnnouncement, updateSignageAnnouncement } from '../../api/generated/signage/signage';
import { DateTimeInput } from '../../app/DateInput';
import { AnnouncementFieldInput } from './AnnouncementFieldInput';
import { AnnouncementPreview } from './AnnouncementPreview';
import { defaultsOf, fromLocalValue, mapAnnouncementError, nextHour, toLocalValue, type ServerErrors } from './announcementForm';
import { usePublishedView } from './displayHooks';
import { PublishedScreen } from './displayParts';
import { renderAnnouncement } from './engine/announcements';
import { isStaleWrite } from './helpers';
import { useMachineOptions, useMakerspaceTimeZone } from './preview';
import { displaysQuery, signageKeys, templatesQuery } from './queries';
import type { RenderAnnouncement } from './render/types';

type EndMode = 'stopped' | 'at' | 'after';
type Values = { templateId: string; values: Record<string, string>; target: 'all' | 'selected'; displayIds: string[]; startMode: 'now' | 'at'; startAt: string; endMode: EndMode; endAt: string; duration: string };
type Option = { id: string; label: string };

const DURATIONS = [{ id: '15', label: '15 minutes' }, { id: '30', label: '30 minutes' }, { id: '60', label: '1 hour' }, { id: '120', label: '2 hours' }, { id: 'eod', label: 'End of today' }];
/**
 * Starts (or edits) an announcement: template, its fields, displays, start and end. It applies immediately, no publishing.
 * `display` preselects one display; `announcement` edits a running or scheduled one.
 */
export function AnnouncementStartModal({ display, announcement, onClose }: { display?: SignageDisplay; announcement?: SignageAnnouncement; onClose: () => void }) {
  const queryClient = useQueryClient();
  const timeZone = useMakerspaceTimeZone();
  const { machines } = useMachineOptions();
  const templates = useQuery(templatesQuery()).data?.items ?? [];
  const displays = (useQuery(displaysQuery()).data?.items ?? []).filter((item) => item.status !== 'revoked');
  const initialTemplate = templates.find((item) => item.id === announcement?.templateId) ?? templates[0];
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<ServerErrors>({ fields: {} });
  const form = useForm<Values>({
    defaultValues: {
      templateId: initialTemplate?.id ?? '', values: announcement?.values ?? defaultsOf(initialTemplate?.fields ?? []),
      target: announcement ? (announcement.allDisplays ? 'all' : 'selected') : display ? 'selected' : 'all', displayIds: announcement?.displayIds ?? (display ? [display.id] : []),
      startMode: announcement ? 'at' : 'now', startAt: announcement ? toLocalValue(new Date(announcement.startsAt)) : nextHour(new Date(), 1),
      endMode: announcement?.endsAt ? 'at' : 'stopped', endAt: announcement?.endsAt ? toLocalValue(new Date(announcement.endsAt)) : nextHour(new Date(), 2), duration: '60',
    },
  });
  const draft = useWatch({ control: form.control }) as Values;
  const template = templates.find((item) => item.id === draft.templateId);
  const clearServer = () => setServerErrors({ fields: {} });

  // Times are read in the browser's zone; "now" is evaluated when the dialog renders and again on submit.
  const [openedAt] = useState(() => new Date());
  const startsAt = draft.startMode === 'now' ? openedAt : fromLocalValue(draft.startAt);
  let endsAt: Date | null = null;
  if (startsAt && draft.endMode === 'at') endsAt = fromLocalValue(draft.endAt);
  if (startsAt && draft.endMode === 'after') {
    if (draft.duration === 'eod') { endsAt = new Date(startsAt); endsAt.setHours(24, 0, 0, 0); } else endsAt = new Date(startsAt.getTime() + Number(draft.duration) * 60_000);
  }

  const missing = new Set((template?.fields ?? []).filter((field) => field.required && (draft.values[field.key] ?? '').trim() === '').map((field) => field.key));
  const errors = {
    template: template ? null : 'Choose a template',
    displays: draft.target === 'selected' && draft.displayIds.length === 0 ? 'Choose at least one display' : null,
    start: draft.startMode === 'at' && !startsAt ? 'Choose when it starts' : null,
    end: draft.endMode === 'at' && (!endsAt ? 'Choose when it ends' : startsAt && endsAt.getTime() <= startsAt.getTime() ? 'The end must be after the start' : null) || null,
  };
  const valid = missing.size === 0 && Object.values(errors).every((error) => error === null);

  // {display} and {location} depend on the screen; the preview uses the first one targeted.
  const previewDisplay = (draft.target === 'selected' ? displays.find((item) => draft.displayIds.includes(item.id)) : undefined) ?? display ?? displays[0];
  const machineNames = useMemo(() => Object.fromEntries(machines.map((machine) => [machine.id, machine.name])), [machines]);
  const message = template && startsAt ? renderAnnouncement(template, draft.values, { startsAt, endsAt }, { now: new Date(), timeZone, displayName: previewDisplay?.name ?? 'Display', location: previewDisplay?.location ?? '', machines: machineNames }) : null;
  const extra = useMemo<RenderAnnouncement[]>(() => (message && template ? [{ id: 'draft', templateId: template.id, tone: message.tone, title: message.title, body: message.body, startsAt: 0 }] : []), [message?.title, message?.body, message?.tone, template?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = usePublishedView(previewDisplay?.id ?? '', { extra, omitAnnouncementId: announcement?.id }, Boolean(previewDisplay));

  const mutation = useMutation({
    mutationFn: () => {
      const targets = draft.target === 'all' ? { allDisplays: true, displayIds: [] } : { allDisplays: false, displayIds: draft.displayIds };
      const window = { endsAt: endsAt ? endsAt.toISOString() : null };
      return announcement
        ? updateSignageAnnouncement(announcement.id, { expectedVersion: announcement.version, values: draft.values, ...targets, startsAt: startsAt!.toISOString(), ...window })
        : startSignageAnnouncement({ templateId: draft.templateId, values: draft.values, ...targets, ...(draft.startMode === 'at' ? { startsAt: startsAt!.toISOString() } : {}), ...window });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: signageKeys.all }); onClose(); },
    onError: (error) => {
      if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.announcements() });
      else setServerErrors(mapAnnouncementError(error, template?.fields ?? []));
    },
  });

  const submit = () => {
    setShowErrors(true);
    clearServer();
    if (valid && template && startsAt) mutation.mutate();
  };
  const chooseTemplate = (id: string) => {
    form.setValue('templateId', id);
    form.setValue('values', defaultsOf(templates.find((item) => item.id === id)?.fields ?? []));
    clearServer();
  };
  const setValue = (key: string, value: string) => { form.setValue('values', { ...form.getValues('values'), [key]: value }); clearServer(); };
  const displayItems: Option[] = displays.map((item) => ({ id: item.id, label: item.name }));
  const primary = announcement ? 'Save changes' : draft.startMode === 'now' ? 'Start now' : 'Schedule';

  return (
    <Modal
      open size="md" modalHeading={announcement ? 'Edit announcement' : 'New announcement'} modalLabel={display ? display.name : 'Announcements'} primaryButtonText={mutation.isPending ? 'Saving…' : primary} secondaryButtonText="Cancel"
      primaryButtonDisabled={templates.length === 0 || mutation.isPending} preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={submit}
    >
      <Stack gap={6}>
        {templates.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No templates yet" subtitle="Create an announcement template under Content › Announcements first." />}
        <Select id="ann-template" labelText="Template" value={draft.templateId} disabled={Boolean(announcement)} invalid={showErrors && Boolean(errors.template)} invalidText={errors.template ?? ''} onChange={(event) => chooseTemplate(event.target.value)}>
          {templates.map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}
        </Select>
        {template?.fields.map((field) => (
          <div key={`${template.id}-${field.key}`}>
            <AnnouncementFieldInput id={`ann-field-${field.key}`} field={field} machines={machines} value={draft.values[field.key] ?? ''} invalid={(showErrors && missing.has(field.key)) || Boolean(serverErrors.fields[field.key])} onChange={(value) => setValue(field.key, value)} />
            {serverErrors.fields[field.key] && <p className="sg-error-text" role="alert">{serverErrors.fields[field.key]}</p>}
          </div>
        ))}

        <RadioButtonGroup legendText="Shown on" name="ann-target" valueSelected={draft.target} onChange={(value) => { form.setValue('target', value as Values['target']); clearServer(); }}>
          <RadioButton id="ann-target-all" value="all" labelText="All displays" />
          <RadioButton id="ann-target-selected" value="selected" labelText="Selected displays" />
        </RadioButtonGroup>
        {draft.target === 'selected' && (
          <MultiSelect<Option>
            key={displayItems.length} id="ann-displays" titleText="Displays" label="Choose displays" items={displayItems} itemToString={(item) => item?.label ?? ''} initialSelectedItems={displayItems.filter((item) => draft.displayIds.includes(item.id))}
            invalid={(showErrors && Boolean(errors.displays)) || Boolean(serverErrors.displays)} invalidText={errors.displays ?? serverErrors.displays ?? ''}
            onChange={({ selectedItems }) => { form.setValue('displayIds', (selectedItems ?? []).map((item) => item.id)); clearServer(); }}
          />
        )}

        <RadioButtonGroup legendText="Start" name="ann-start" valueSelected={draft.startMode} onChange={(value) => form.setValue('startMode', value as Values['startMode'])}>
          <RadioButton id="ann-start-now" value="now" labelText="Now" />
          <RadioButton id="ann-start-at" value="at" labelText="At a date and time" />
        </RadioButtonGroup>
        {draft.startMode === 'at' && (
          <div>
            <DateTimeInput id="ann-start-at-input" labelText="Starts" value={draft.startAt} onChange={(value) => { form.setValue('startAt', value); clearServer(); }} />
            {((showErrors && errors.start) || serverErrors.start) && <p className="sg-error-text" role="alert">{errors.start ?? serverErrors.start}</p>}
          </div>
        )}

        <RadioButtonGroup legendText="End" name="ann-end" valueSelected={draft.endMode} onChange={(value) => form.setValue('endMode', value as EndMode)}>
          <RadioButton id="ann-end-stopped" value="stopped" labelText="Until I stop it" />
          <RadioButton id="ann-end-at" value="at" labelText="At a date and time" />
          <RadioButton id="ann-end-after" value="after" labelText="After a duration" />
        </RadioButtonGroup>
        {draft.endMode === 'at' && <DateTimeInput id="ann-end-at-input" labelText="Ends" value={draft.endAt} onChange={(value) => { form.setValue('endAt', value); clearServer(); }} />}
        {draft.endMode === 'after' && (
          <Select id="ann-duration" labelText="Ends after" value={draft.duration} onChange={(event) => form.setValue('duration', event.target.value)}>
            {DURATIONS.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
          </Select>
        )}
        {((showErrors && errors.end) || serverErrors.end) && <p className="sg-error-text" role="alert">{errors.end ?? serverErrors.end}</p>}
        <p className="sg-secondary">The end time feeds {'{ends}'}, {'{ends_at}'} and {'{ends_on}'} in the message. It applies immediately; nothing needs publishing.</p>

        <div>
          <h3 className="sg-section-title">Preview</h3>
          {message ? <AnnouncementPreview message={message} /> : <p className="sg-secondary">Fill in the form to see the message.</p>}
          {message && previewDisplay && (
            <div className="sg-top-gap">
              <p className="sg-secondary">{previewDisplay.name} would show:</p>
              {frame.view
                ? <div className="sg-ann-preview"><PublishedScreen view={frame.view} orientation={previewDisplay.orientation} resolution={previewDisplay.resolution} width={previewDisplay.orientation === 'portrait' ? '8rem' : '100%'} /></div>
                : <p className="sg-secondary">{frame.preview.isPending ? 'Loading the display…' : 'This display has no published scene yet.'}</p>}
            </div>
          )}
        </div>
        {serverErrors.general && <InlineNotification kind="error" lowContrast hideCloseButton title="Announcement not saved" subtitle={serverErrors.general} />}
        {mutation.isError && isStaleWrite(mutation.error) && <InlineNotification kind="error" lowContrast hideCloseButton title="Announcement not saved" subtitle="Somebody else changed or stopped this announcement. Close the dialog and open it again." />}
      </Stack>
    </Modal>
  );
}
