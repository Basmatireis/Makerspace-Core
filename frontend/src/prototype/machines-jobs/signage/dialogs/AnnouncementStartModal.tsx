import { useState } from 'react';
import { InlineNotification, Modal, MultiSelect, RadioButton, RadioButtonGroup, Select, SelectItem, Stack } from '@carbon/react';
import { AnnouncementFieldInput, DateTimeInput } from '../components/AnnouncementFieldInput';
import { AnnouncementPreview } from '../components/AnnouncementPreview';
import { DisplayScreen } from '../components/DisplayScreen';
import { parseLocal } from '../engine';
import { defaultValues, renderFor, toDateTimeValue } from '../helpers';
import { useSignage } from '../SignageContext';
import { useNow, useStore } from '../../store';
import type { Announcement, Display } from '../types';

type EndMode = 'stopped' | 'at' | 'after';
const DURATIONS = [{ id: '15', label: '15 minutes' }, { id: '30', label: '30 minutes' }, { id: '60', label: '1 hour' }, { id: '120', label: '2 hours' }, { id: 'eod', label: 'End of today' }];
type DisplayOption = { id: string; label: string };

const nextHour = (from: Date, hours = 1) => { const date = new Date(from); date.setMinutes(0, 0, 0); date.setHours(date.getHours() + hours); return toDateTimeValue(date); };

/**
 * Starts (or edits) an announcement: template, its fields, displays, start and end. Applies immediately, no publishing.
 * `display` preselects one display, `announcement` edits a running or scheduled one.
 */
export function AnnouncementStartModal({ display, announcement, onClose }: { display?: Display; announcement?: Announcement; onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const now = useNow(1000);
  const { announcementTemplates: templates } = signage;
  const displays = signage.displays.filter((item) => !item.revoked);
  const [templateId, setTemplateId] = useState(announcement?.templateId ?? templates[0]?.id ?? '');
  const template = templates.find((item) => item.id === templateId);
  const [values, setValues] = useState<Record<string, string>>(announcement?.values ?? (template ? defaultValues(template.fields) : {}));
  const [target, setTarget] = useState<'all' | 'selected'>(announcement ? (announcement.displayIds ? 'selected' : 'all') : display ? 'selected' : 'all');
  const [displayIds, setDisplayIds] = useState<string[]>(announcement?.displayIds ?? (display ? [display.id] : []));
  const [startMode, setStartMode] = useState<'now' | 'at'>(announcement ? 'at' : 'now');
  const [startAt, setStartAt] = useState(announcement ? toDateTimeValue(new Date(announcement.startsAt)) : nextHour(new Date()));
  const [endMode, setEndMode] = useState<EndMode>(announcement?.endsAt ? 'at' : 'stopped');
  const [endAt, setEndAt] = useState(announcement?.endsAt ? toDateTimeValue(new Date(announcement.endsAt)) : nextHour(new Date(), 2));
  const [duration, setDuration] = useState('60');
  const [touched, setTouched] = useState(false);

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const next = templates.find((item) => item.id === id);
    setValues(next ? defaultValues(next.fields) : {});
  };

  const startsAt = startMode === 'now' ? new Date(now) : parseLocal(startAt);
  let endsAt: Date | null = null;
  if (startsAt && endMode === 'at') endsAt = parseLocal(endAt);
  if (startsAt && endMode === 'after') {
    if (duration === 'eod') { endsAt = new Date(startsAt); endsAt.setHours(24, 0, 0, 0); } else endsAt = new Date(startsAt.getTime() + Number(duration) * 60_000);
  }

  const missing = new Set(template?.fields.filter((field) => field.required && (values[field.key] ?? '').trim() === '').map((field) => field.key));
  const errors = {
    template: template ? null : 'Choose a template',
    displays: target === 'selected' && displayIds.length === 0 ? 'Choose at least one display' : null,
    start: startMode === 'at' && !startsAt ? 'Choose when it starts' : null,
    end: endMode === 'at' && (!endsAt || (startsAt && endsAt.getTime() <= startsAt.getTime())) ? (endsAt ? 'The end must be after the start' : 'Choose when it ends') : null,
  };
  const valid = missing.size === 0 && Object.values(errors).every((error) => error === null);

  const targetIds = target === 'all' ? null : displayIds;
  // `{display}` and `{location}` depend on the screen; the preview uses the first one targeted.
  const previewDisplay = (target === 'selected' ? displays.find((item) => displayIds.includes(item.id)) : undefined) ?? display ?? displays[0];
  const draft: Announcement | null = template && startsAt ? { id: 'draft', templateId: template.id, values, displayIds: previewDisplay ? [previewDisplay.id] : [], startsAt: startsAt.toISOString(), endsAt: endsAt ? endsAt.toISOString() : null } : null;
  const message = draft && template && previewDisplay ? renderFor(draft, template, previewDisplay, new Date(now)) : null;
  // The frame preview shows what the display would run with the draft already in force, and without the copy being edited.
  const frameDrafts = draft ? [{ ...draft, startsAt: new Date(Math.min(startsAt!.getTime(), now)).toISOString() }] : [];

  const submit = () => {
    setTouched(true);
    if (!valid || !template || !startsAt) return;
    const input = { templateId: template.id, values, displayIds: targetIds, startsAt: startsAt.toISOString(), endsAt: endsAt ? endsAt.toISOString() : null };
    if (announcement) signage.updateAnnouncement(announcement.id, input); else signage.startAnnouncement(input);
    const later = startMode === 'at' && startsAt.getTime() > Date.now();
    store.notify({ kind: 'success', title: announcement ? 'Announcement updated' : later ? 'Announcement scheduled' : 'Announcement is live', subtitle: later ? `It starts at ${startAt.replace('T', ' ')}.` : 'Displays switched immediately; nothing to publish.' });
    onClose();
  };

  const primary = announcement ? 'Save changes' : startMode === 'now' ? 'Start now' : 'Schedule';

  return (
    <Modal open size="md" modalHeading={announcement ? 'Edit announcement' : 'New announcement'} modalLabel={display ? display.name : 'Announcements'} primaryButtonText={primary} secondaryButtonText="Cancel" primaryButtonDisabled={templates.length === 0} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={submit}>
      <Stack gap={6}>
        {templates.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No templates yet" subtitle="Create an announcement template under Content › Announcements first." />}
        <Select id="ann-template" labelText="Template" value={templateId} invalid={touched && Boolean(errors.template)} invalidText={errors.template ?? ''} onChange={(event) => chooseTemplate(event.target.value)}>
          {templates.map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}
        </Select>
        {template?.fields.map((field) => (
          <AnnouncementFieldInput key={`${template.id}-${field.id}`} id={`ann-field-${field.id}`} field={field} value={values[field.key] ?? ''} invalid={touched && missing.has(field.key)} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
        ))}

        <RadioButtonGroup legendText="Shown on" name="ann-target" valueSelected={target} onChange={(value) => setTarget(value as 'all' | 'selected')}>
          <RadioButton id="ann-target-all" value="all" labelText="All displays" />
          <RadioButton id="ann-target-selected" value="selected" labelText="Selected displays" />
        </RadioButtonGroup>
        {target === 'selected' && (
          <MultiSelect<DisplayOption> id="ann-displays" titleText="Displays" label="Choose displays" items={displays.map((item) => ({ id: item.id, label: item.name }))} itemToString={(item) => item?.label ?? ''}
            initialSelectedItems={displays.filter((item) => displayIds.includes(item.id)).map((item) => ({ id: item.id, label: item.name }))} invalid={touched && Boolean(errors.displays)} invalidText={errors.displays ?? ''}
            onChange={({ selectedItems }) => setDisplayIds((selectedItems ?? []).map((item) => item.id))} />
        )}

        <RadioButtonGroup legendText="Start" name="ann-start" valueSelected={startMode} onChange={(value) => setStartMode(value as 'now' | 'at')}>
          <RadioButton id="ann-start-now" value="now" labelText="Now" />
          <RadioButton id="ann-start-at" value="at" labelText="At a date and time" />
        </RadioButtonGroup>
        {startMode === 'at' && <DateTimeInput id="ann-start-at-input" label="Starts at" value={startAt} onChange={setStartAt} invalid={touched && Boolean(errors.start)} invalidText={errors.start ?? ''} />}

        <RadioButtonGroup legendText="End" name="ann-end" valueSelected={endMode} onChange={(value) => setEndMode(value as EndMode)}>
          <RadioButton id="ann-end-stopped" value="stopped" labelText="Until I stop it" />
          <RadioButton id="ann-end-at" value="at" labelText="At a date and time" />
          <RadioButton id="ann-end-after" value="after" labelText="After a duration" />
        </RadioButtonGroup>
        {endMode === 'at' && <DateTimeInput id="ann-end-at-input" label="Ends at" value={endAt} onChange={setEndAt} invalid={touched && Boolean(errors.end)} invalidText={errors.end ?? ''} />}
        {endMode === 'after' && (
          <Select id="ann-duration" labelText="Ends after" value={duration} onChange={(event) => setDuration(event.target.value)}>
            {DURATIONS.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
          </Select>
        )}
        <p className="mj-secondary">The end time feeds {'{ends}'}, {'{ends_at}'} and {'{ends_on}'} in the message. It applies immediately; nothing needs publishing.</p>

        <div>
          <h3 className="mj-section-title">Preview</h3>
          {message ? <AnnouncementPreview message={message} /> : <p className="mj-secondary">Fill in the form to see the message.</p>}
          {draft && previewDisplay && (
            <div className="sg-top-gap">
              <p className="mj-secondary">{previewDisplay.name} would show:</p>
              <div className="sg-ann-preview"><DisplayScreen display={previewDisplay} sim={signage.sim} now={now} media={signage.media} width={previewDisplay.orientation === 'portrait' ? '8rem' : '100%'} extraAnnouncements={frameDrafts} omitAnnouncementId={announcement?.id} /></div>
            </div>
          )}
        </div>
      </Stack>
    </Modal>
  );
}
