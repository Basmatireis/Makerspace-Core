import { useRef, useState, type RefObject } from 'react';
import { Button, Checkbox, ContainedList, ContainedListItem, IconButton, MenuButton, MenuItem, MenuItemDivider, Modal, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { AnnouncementPreview } from '../components/AnnouncementPreview';
import { BUILT_IN_VARIABLES, fieldKeyFor, placeholdersIn, renderAnnouncement, unknownPlaceholders } from '../engine';
import { pluralize, sampleValues, uid } from '../helpers';
import { useSignage } from '../SignageContext';
import { useStore } from '../../store';
import type { AnnouncementField, AnnouncementTemplate, FieldType, Tone } from '../types';

const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'Text' }, { id: 'longtext', label: 'Long text' }, { id: 'time', label: 'Time' }, { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date and time' }, { id: 'number', label: 'Number' }, { id: 'choice', label: 'Choice' }, { id: 'machine', label: 'Machine' },
];
const TONES: { id: Tone; label: string }[] = [{ id: 'info', label: 'Info (blue)' }, { id: 'warning', label: 'Warning (yellow)' }, { id: 'critical', label: 'Critical (red)' }, { id: 'neutral', label: 'Neutral (grey)' }];

const newField = (taken: string[]): AnnouncementField => ({ id: uid('fld'), key: fieldKeyFor('Field', taken), label: '', type: 'text', required: false, defaultValue: '', helper: '', options: [] });

type Target = { ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>; value: string; set: (value: string) => void };

/** Creates or edits an announcement template: fields, message with {placeholders}, tone and a live preview. */
export function AnnouncementTemplateModal({ template, onClose }: { template?: AnnouncementTemplate; onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const [name, setName] = useState(template?.name ?? '');
  const [tone, setTone] = useState<Tone>(template?.tone ?? 'info');
  const [fields, setFields] = useState<AnnouncementField[]>(template?.fields ?? []);
  const [title, setTitle] = useState(template?.title ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [touched, setTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // The caret position survives the menu taking focus.
  const caret = useRef({ title: 0, body: 0 });
  const now = new Date();

  const usedBy = template ? signage.announcements.filter((item) => item.templateId === template.id && (!item.endsAt || Date.parse(item.endsAt) > now.getTime())).length : 0;
  const draft = { fields, title, body, tone };
  const unknownTitle = unknownPlaceholders({ fields, title, body: '' });
  const unknownBody = unknownPlaceholders({ fields, title: '', body });
  const preview = renderAnnouncement(draft, sampleValues(fields, now), { startsAt: now, endsAt: new Date(now.getTime() + 2 * 3_600_000) }, { now, displayName: 'Entrance window', location: 'Ground floor' });

  const errors = {
    name: name.trim() === '' ? 'Give the template a name' : null,
    title: title.trim() === '' ? 'The message needs a title' : null,
    fields: fields.some((field) => field.label.trim() === '' || (field.type === 'choice' && field.options.length === 0)) ? 'Every field needs a label, and a choice needs at least one option' : null,
  };
  const valid = Object.values(errors).every((error) => error === null);

  const patchField = (id: string, patch: Partial<AnnouncementField>) => setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
  const rename = (field: AnnouncementField, label: string) => {
    // The key follows the label until the message uses it; after that it stays, so existing placeholders keep working.
    const used = placeholdersIn(`${title} ${body}`).includes(field.key);
    const others = fields.filter((item) => item.id !== field.id).map((item) => item.key);
    patchField(field.id, { label, ...(used ? {} : { key: fieldKeyFor(label, others) }) });
  };
  const move = (index: number, direction: -1 | 1) => setFields((current) => {
    const next = [...current];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    return next;
  });

  const insert = (target: Target, key: 'title' | 'body', variable: string) => {
    const at = Math.min(caret.current[key], target.value.length);
    const text = `{${variable}}`;
    target.set(`${target.value.slice(0, at)}${text}${target.value.slice(at)}`);
    caret.current[key] = at + text.length;
  };
  const targets: Record<'title' | 'body', Target> = { title: { ref: titleRef, value: title, set: setTitle }, body: { ref: bodyRef, value: body, set: setBody } };
  const variableMenu = (key: 'title' | 'body') => (
    <MenuButton label="Insert variable" kind="ghost" size="sm" menuAlignment="bottom-start">
      {fields.filter((field) => field.label.trim() !== '').map((field) => <MenuItem key={field.id} label={`${field.label}  {${field.key}}`} onClick={() => insert(targets[key], key, field.key)} />)}
      {fields.length > 0 && <MenuItemDivider />}
      {BUILT_IN_VARIABLES.map((item) => <MenuItem key={item.key} label={`${item.label}  {${item.key}}`} onClick={() => insert(targets[key], key, item.key)} />)}
    </MenuButton>
  );
  const track = (key: 'title' | 'body') => ({ onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => { caret.current[key] = event.currentTarget.selectionStart ?? event.currentTarget.value.length; } });

  const save = () => {
    setTouched(true);
    if (!valid) return;
    signage.saveAnnouncementTemplate({ id: template?.id ?? uid('tpl'), name: name.trim(), tone, fields: fields.map((field) => ({ ...field, label: field.label.trim() })), title: title.trim(), body });
    store.notify({ kind: 'success', title: template ? 'Template saved' : 'Template created', subtitle: name.trim() });
    onClose();
  };

  return (
    <Modal open size="lg" modalHeading={template ? 'Edit announcement template' : 'New announcement template'} modalLabel="Announcements" primaryButtonText={template ? 'Save template' : 'Create template'} secondaryButtonText="Cancel" preventCloseOnClickOutside selectorsFloatingMenus={['.cds--menu']} onRequestClose={onClose} onRequestSubmit={save}>
      <div className="sg-template-modal">
        <Stack gap={5}>
          {template && <p className="mj-secondary">Used in {pluralize(usedBy, 'active announcement')}. Changes apply to them right away.</p>}
          <TextInput id="tpl-name" labelText="Name" placeholder="e.g. Closed" value={name} invalid={touched && Boolean(errors.name)} invalidText={errors.name ?? ''} onChange={(event) => setName(event.target.value)} />
          <div className="sg-form-row">
            <Select id="tpl-tone" labelText="Tone" value={tone} onChange={(event) => setTone(event.target.value as Tone)}>
              {TONES.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
            </Select>
          </div>

          <div>
            <p className="mj-secondary">What the person starting the announcement fills in. Use them in the message as {'{key}'}.</p>
            <ContainedList label="Fields" kind="on-page" isInset>
              {fields.length === 0 && <ContainedListItem>No fields yet. A message without fields is shown as written.</ContainedListItem>}
              {fields.map((field, index) => (
                <ContainedListItem key={field.id}>
                  <div className="sg-field-editor">
                    <div className="sg-form-row">
                      <TextInput id={`tpl-field-label-${field.id}`} labelText="Label" value={field.label} invalid={touched && field.label.trim() === ''} invalidText="Give the field a label" onChange={(event) => rename(field, event.target.value)} helperText={`Variable {${field.key}}`} />
                      <Select id={`tpl-field-type-${field.id}`} labelText="Type" value={field.type} onChange={(event) => patchField(field.id, { type: event.target.value as FieldType, defaultValue: '' })}>
                        {FIELD_TYPES.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
                      </Select>
                    </div>
                    {field.type === 'choice' && (
                      <TextArea id={`tpl-field-options-${field.id}`} labelText="Options (one per line)" rows={3} value={field.options.join('\n')} invalid={touched && field.options.length === 0} invalidText="Add at least one option"
                        onChange={(event) => patchField(field.id, { options: event.target.value.split('\n').map((option) => option.trim()).filter((option) => option !== '') })} />
                    )}
                    <div className="sg-form-row">
                      <TextInput id={`tpl-field-default-${field.id}`} labelText="Default value (optional)" value={field.defaultValue} onChange={(event) => patchField(field.id, { defaultValue: event.target.value })} helperText={field.type === 'date' ? 'Format yyyy-mm-dd' : field.type === 'datetime' ? 'Format yyyy-mm-ddThh:mm' : field.type === 'time' ? 'Format hh:mm' : undefined} />
                      <TextInput id={`tpl-field-helper-${field.id}`} labelText="Helper text (optional)" value={field.helper} onChange={(event) => patchField(field.id, { helper: event.target.value })} />
                    </div>
                    <div className="sg-field-editor__bar">
                      <Checkbox id={`tpl-field-required-${field.id}`} labelText="Required" checked={field.required} onChange={(_, { checked }) => patchField(field.id, { required: checked })} />
                      <div className="mj-inline">
                        <IconButton label="Move up" kind="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                        <IconButton label="Move down" kind="ghost" size="sm" disabled={index === fields.length - 1} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                        <IconButton label="Remove field" kind="ghost" size="sm" onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}><TrashCan /></IconButton>
                      </div>
                    </div>
                  </div>
                </ContainedListItem>
              ))}
            </ContainedList>
            {touched && errors.fields && <p className="cds--form-requirement sg-field-error" role="alert">{errors.fields}</p>}
            <Button className="sg-top-gap" kind="tertiary" size="sm" renderIcon={Add} onClick={() => setFields((current) => [...current, newField(current.map((item) => item.key))])}>Add field</Button>
          </div>

          <div>
            <h3 className="mj-section-title">Message</h3>
            <div className="sg-message-field">
              <div className="sg-message-field__bar">{variableMenu('title')}</div>
              <TextInput id="tpl-title" ref={titleRef} labelText="Title" placeholder="e.g. Closed today – {reason}" value={title} {...track('title')} invalid={touched && Boolean(errors.title)} invalidText={errors.title ?? ''}
                warn={unknownTitle.length > 0} warnText={`Unknown variable ${unknownTitle.map((key) => `{${key}}`).join(', ')}. It is shown as typed.`} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="sg-message-field sg-top-gap">
              <div className="sg-message-field__bar">{variableMenu('body')}</div>
              <TextArea id="tpl-body" ref={bodyRef} labelText="Body (optional)" rows={3} value={body} {...track('body')}
                warn={unknownBody.length > 0} warnText={`Unknown variable ${unknownBody.map((key) => `{${key}}`).join(', ')}. It is shown as typed.`} onChange={(event) => setBody(event.target.value)} />
            </div>
          </div>

          <div>
            <h3 className="mj-section-title">Preview</h3>
            <p className="mj-secondary">With sample values, ending in two hours.</p>
            <AnnouncementPreview message={preview} />
          </div>
        </Stack>
      </div>
    </Modal>
  );
}
