import { useRef } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  Checkbox,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  MenuButton,
  MenuItem,
  MenuItemDivider,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type {
  SignageAnnouncementTemplate,
  SignageFieldType,
  SignageRichTextFormat,
  SignageTone,
} from '../../api/generated/models';
import {
  createSignageAnnouncementTemplate,
  updateSignageAnnouncementTemplate,
} from '../../api/generated/signage/signage';
import { AnnouncementPreview } from './AnnouncementPreview';
import { BUILT_IN_VARIABLES, fieldKeyFor, placeholdersIn, unknownPlaceholders } from './engine/announcements';
import { errorMessage, isStaleWrite, pluralize } from './helpers';
import { CodeArea, FormatSelect } from './RichTextFields';
import { LIMITS } from './widgets';
import { announcementsQuery, signageKeys } from './queries';
import { renderSample, useMachineOptions, useMakerspaceTimeZone } from './preview';

const FIELD_TYPES: { id: SignageFieldType; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'longtext', label: 'Long text' },
  { id: 'time', label: 'Time' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date and time' },
  { id: 'number', label: 'Number' },
  { id: 'choice', label: 'Choice' },
  { id: 'machine', label: 'Machine' },
];
const TONES: { id: SignageTone; label: string }[] = [
  { id: 'info', label: 'Info (blue)' },
  { id: 'warning', label: 'Warning (yellow)' },
  { id: 'critical', label: 'Critical (red)' },
  { id: 'neutral', label: 'Neutral (grey)' },
];

type FieldValues = {
  key: string;
  label: string;
  type: SignageFieldType;
  required: boolean;
  defaultValue: string;
  helperText: string;
  options: string;
  locked: boolean;
};
type Values = {
  name: string;
  tone: SignageTone;
  title: string;
  body: string;
  bodyFormat: SignageRichTextFormat;
  bodyCss: string;
  fields: FieldValues[];
};

const toFieldValues = (template?: SignageAnnouncementTemplate): FieldValues[] =>
  (template?.fields ?? []).map((field) => ({ ...field, options: field.options.join('\n'), locked: true }));
const splitOptions = (text: string) =>
  text
    .split('\n')
    .map((option) => option.trim())
    .filter((option) => option !== '');

/** Creates or edits an announcement template: fields, message with {placeholders}, tone and a live preview. */
export function AnnouncementTemplateModal({
  template,
  onClose,
}: {
  template?: SignageAnnouncementTemplate;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { machines } = useMachineOptions();
  const timeZone = useMakerspaceTimeZone();
  const announcements = useQuery(announcementsQuery());
  const form = useForm<Values>({
    defaultValues: {
      name: template?.name ?? '',
      tone: template?.tone ?? 'info',
      title: template?.title ?? '',
      body: template?.body ?? '',
      bodyFormat: template?.bodyFormat ?? 'plain',
      bodyCss: template?.bodyCss ?? '',
      fields: toFieldValues(template),
    },
  });
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: 'fields' });
  const watched = useWatch({ control: form.control });
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // The caret position survives the menu taking focus.
  const caret = useRef({ title: 0, body: 0 });
  const now = new Date();

  const title = watched.title ?? '';
  const body = watched.body ?? '';
  const bodyFormat = watched.bodyFormat ?? 'plain';
  const bodyCss = watched.bodyCss ?? '';
  const draftFields = (watched.fields ?? []).map((field) => ({
    key: field.key ?? '',
    label: field.label ?? '',
    type: field.type ?? 'text',
    required: field.required ?? false,
    defaultValue: field.defaultValue ?? '',
    helperText: field.helperText ?? '',
    options: splitOptions(field.options ?? ''),
  }));
  const unknownTitle = unknownPlaceholders({ fields: draftFields, title, body: '' });
  const unknownBody = unknownPlaceholders({ fields: draftFields, title: '', body });
  const preview = renderSample(
    { fields: draftFields, title, body, tone: watched.tone ?? 'info', bodyFormat, bodyCss },
    Object.fromEntries(machines.map((machine) => [machine.id, machine.name])),
    now,
    timeZone,
  );
  const inUse = template
    ? (announcements.data?.items ?? []).filter((item) => item.templateId === template.id).length
    : 0;

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const request = {
        name: values.name.trim(),
        tone: values.tone,
        title: values.title.trim(),
        body: values.body,
        bodyFormat: values.bodyFormat,
        bodyCss: values.bodyCss,
        fields: values.fields.map((field) => ({
          key: field.key,
          label: field.label.trim(),
          type: field.type,
          required: field.required,
          defaultValue: field.defaultValue,
          helperText: field.helperText,
          options: field.type === 'choice' ? splitOptions(field.options) : [],
        })),
      };
      return template
        ? updateSignageAnnouncementTemplate(template.id, { expectedVersion: template.version, ...request })
        : createSignageAnnouncementTemplate(request);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.all });
      onClose();
    },
    onError: (error) => {
      if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.templates() });
    },
  });

  const rename = (index: number, label: string) => {
    const field = form.getValues(`fields.${index}`);
    form.setValue(`fields.${index}.label`, label, { shouldDirty: true });
    // The key follows the label until the message uses it or the field was saved before; after that it stays so placeholders keep working.
    if (field.locked || placeholdersIn(`${form.getValues('title')} ${form.getValues('body')}`).includes(field.key))
      return;
    const others = form
      .getValues('fields')
      .filter((_, at) => at !== index)
      .map((item) => item.key);
    form.setValue(`fields.${index}.key`, fieldKeyFor(label, others), { shouldDirty: true });
  };
  const addField = () =>
    append({
      key: fieldKeyFor(
        'Field',
        form.getValues('fields').map((item) => item.key),
      ),
      label: '',
      type: 'text',
      required: false,
      defaultValue: '',
      helperText: '',
      options: '',
      locked: false,
    });

  const insert = (target: 'title' | 'body', variable: string) => {
    const current = form.getValues(target);
    const at = Math.min(caret.current[target], current.length);
    const text = `{${variable}}`;
    form.setValue(target, `${current.slice(0, at)}${text}${current.slice(at)}`, {
      shouldDirty: true,
      shouldValidate: true,
    });
    caret.current[target] = at + text.length;
  };
  const variableMenu = (target: 'title' | 'body') => (
    <MenuButton label="Insert variable" kind="ghost" size="sm" menuAlignment="bottom-start">
      {draftFields
        .filter((field) => field.label.trim() !== '')
        .map((field) => (
          <MenuItem
            key={field.key}
            label={`${field.label}  {${field.key}}`}
            onClick={() => insert(target, field.key)}
          />
        ))}
      {draftFields.length > 0 && <MenuItemDivider />}
      {BUILT_IN_VARIABLES.map((item) => (
        <MenuItem key={item.key} label={`${item.label}  {${item.key}}`} onClick={() => insert(target, item.key)} />
      ))}
    </MenuButton>
  );
  const track = (target: 'title' | 'body') => ({
    onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      caret.current[target] = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
    },
  });
  const warning = (keys: string[]) =>
    keys.length > 0 ? `Unknown variable ${keys.map((key) => `{${key}}`).join(', ')}. It is shown as typed.` : undefined;

  return (
    <Modal
      open
      size="lg"
      modalHeading={template ? 'Edit announcement template' : 'New announcement template'}
      modalLabel="Announcements"
      primaryButtonText={mutation.isPending ? 'Saving…' : template ? 'Save template' : 'Create template'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      selectorsFloatingMenus={['.cds--menu']}
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <div className="sg-template-modal">
        <Stack gap={5}>
          {template && (
            <p className="sg-secondary">
              Used in {pluralize(inUse, 'active or scheduled announcement')}. Changes apply to them right away.
            </p>
          )}
          <TextInput
            id="tpl-name"
            labelText="Name"
            placeholder="e.g. Closed"
            maxLength={100}
            invalid={Boolean(form.formState.errors.name)}
            invalidText="Give the template a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <div className="sg-form-row">
            <Select id="tpl-tone" labelText="Tone" {...form.register('tone')}>
              {TONES.map((item) => (
                <SelectItem key={item.id} value={item.id} text={item.label} />
              ))}
            </Select>
          </div>

          <div>
            <p className="sg-secondary">
              What the person starting the announcement fills in. Use them in the message as {'{key}'}.
            </p>
            <ContainedList label="Fields" kind="on-page" isInset>
              {fields.length === 0 && (
                <ContainedListItem>No fields yet. A message without fields is shown as written.</ContainedListItem>
              )}
              {fields.map((field, index) => {
                const current = watched.fields?.[index];
                return (
                  <ContainedListItem key={field.id}>
                    <div className="sg-field-editor">
                      <div className="sg-form-row">
                        <Controller
                          control={form.control}
                          name={`fields.${index}.label`}
                          rules={{ validate: (value) => value.trim() !== '' }}
                          render={({ field: label }) => (
                            <TextInput
                              id={`tpl-field-label-${field.id}`}
                              labelText="Label"
                              maxLength={100}
                              value={label.value}
                              invalid={Boolean(form.formState.errors.fields?.[index]?.label)}
                              invalidText="Give the field a label"
                              helperText={`Variable {${current?.key ?? field.key}}`}
                              onChange={(event) => rename(index, event.target.value)}
                              onBlur={label.onBlur}
                            />
                          )}
                        />
                        <Select
                          id={`tpl-field-type-${field.id}`}
                          labelText="Type"
                          {...form.register(`fields.${index}.type`, {
                            onChange: () => form.setValue(`fields.${index}.defaultValue`, ''),
                          })}
                        >
                          {FIELD_TYPES.map((item) => (
                            <SelectItem key={item.id} value={item.id} text={item.label} />
                          ))}
                        </Select>
                      </div>
                      {current?.type === 'choice' && (
                        <TextArea
                          id={`tpl-field-options-${field.id}`}
                          labelText="Options (one per line)"
                          rows={3}
                          invalid={Boolean(form.formState.errors.fields?.[index]?.options)}
                          invalidText="Add at least one option (up to 20, 100 characters each)"
                          {...form.register(`fields.${index}.options`, {
                            validate: (value) => {
                              const options = splitOptions(value);
                              return (
                                options.length >= 1 &&
                                options.length <= 20 &&
                                options.every((option) => option.length <= 100)
                              );
                            },
                          })}
                        />
                      )}
                      <div className="sg-form-row">
                        <TextInput
                          id={`tpl-field-default-${field.id}`}
                          labelText="Default value (optional)"
                          maxLength={2000}
                          helperText={
                            current?.type === 'date'
                              ? 'Format yyyy-mm-dd'
                              : current?.type === 'datetime'
                                ? 'Format yyyy-mm-ddThh:mm'
                                : current?.type === 'time'
                                  ? 'Format hh:mm'
                                  : undefined
                          }
                          {...form.register(`fields.${index}.defaultValue`)}
                        />
                        <TextInput
                          id={`tpl-field-helper-${field.id}`}
                          labelText="Helper text (optional)"
                          maxLength={300}
                          {...form.register(`fields.${index}.helperText`)}
                        />
                      </div>
                      <div className="sg-field-editor__bar">
                        <Controller
                          control={form.control}
                          name={`fields.${index}.required`}
                          render={({ field: required }) => (
                            <Checkbox
                              id={`tpl-field-required-${field.id}`}
                              labelText="Required"
                              checked={required.value}
                              onChange={(_, { checked }) => required.onChange(checked)}
                            />
                          )}
                        />
                        <div className="sg-inline">
                          <IconButton
                            label="Move up"
                            kind="ghost"
                            size="sm"
                            disabled={index === 0}
                            onClick={() => move(index, index - 1)}
                          >
                            <ArrowUp />
                          </IconButton>
                          <IconButton
                            label="Move down"
                            kind="ghost"
                            size="sm"
                            disabled={index === fields.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            <ArrowDown />
                          </IconButton>
                          <IconButton label="Remove field" kind="ghost" size="sm" onClick={() => remove(index)}>
                            <TrashCan />
                          </IconButton>
                        </div>
                      </div>
                    </div>
                  </ContainedListItem>
                );
              })}
            </ContainedList>
            {fields.length < 20 && (
              <Button className="sg-top-gap" kind="tertiary" size="sm" renderIcon={Add} onClick={addField}>
                Add field
              </Button>
            )}
          </div>

          <div>
            <h3 className="sg-section-title">Message</h3>
            <div className="sg-message-field__bar">{variableMenu('title')}</div>
            <Controller
              control={form.control}
              name="title"
              rules={{ validate: (value) => value.trim() !== '' }}
              render={({ field }) => (
                <TextInput
                  id="tpl-title"
                  ref={(node: HTMLInputElement | null) => {
                    titleRef.current = node;
                    field.ref(node);
                  }}
                  labelText="Title"
                  placeholder="e.g. Closed today – {reason}"
                  maxLength={200}
                  value={field.value}
                  {...track('title')}
                  invalid={Boolean(form.formState.errors.title)}
                  invalidText="The message needs a title"
                  warn={unknownTitle.length > 0}
                  warnText={warning(unknownTitle)}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <div className="sg-message-field__bar sg-top-gap">{variableMenu('body')}</div>
            <Controller
              control={form.control}
              name="body"
              render={({ field }) => (
                <TextArea
                  id="tpl-body"
                  ref={(node: HTMLTextAreaElement | null) => {
                    bodyRef.current = node;
                    field.ref(node);
                  }}
                  className={bodyFormat === 'plain' ? undefined : 'sg-code'}
                  labelText="Body (optional)"
                  rows={bodyFormat === 'plain' ? 3 : 6}
                  maxLength={LIMITS.announcementBody}
                  value={field.value}
                  {...track('body')}
                  warn={unknownBody.length > 0}
                  warnText={warning(unknownBody)}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </div>

          <div className="sg-stack">
            <Controller
              control={form.control}
              name="bodyFormat"
              render={({ field }) => (
                <FormatSelect id="tpl-body-format" value={field.value} onChange={field.onChange} />
              )}
            />
            <Accordion size="md" className="sg-style-accordion">
              <AccordionItem title={bodyCss ? 'Body CSS (in use)' : 'Body CSS'}>
                <Controller
                  control={form.control}
                  name="bodyCss"
                  render={({ field }) => (
                    <CodeArea
                      id="tpl-body-css"
                      label="CSS"
                      rows={5}
                      maxCount={LIMITS.css}
                      helperText="Applies to the body inside the announcement. var(--u) is 1 % of the design width."
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </AccordionItem>
            </Accordion>
          </div>

          <div>
            <h3 className="sg-section-title">Preview</h3>
            <p className="sg-secondary">With sample values, ending in two hours.</p>
            <AnnouncementPreview message={preview} />
          </div>
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Template not saved"
              subtitle={
                isStaleWrite(mutation.error)
                  ? 'Somebody else changed this template. Close the dialog and open it again to see the latest version.'
                  : errorMessage(mutation.error)
              }
            />
          )}
        </Stack>
      </div>
    </Modal>
  );
}
