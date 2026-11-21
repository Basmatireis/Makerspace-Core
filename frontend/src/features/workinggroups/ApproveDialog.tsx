import { useState } from 'react';
import {
  Button,
  Checkbox,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import type {
  WorkingGroupProject,
  WorkingGroupProjectPaidFrom,
  WorkingGroupProjectRequestFormInput,
  WorkingGroupProjectUnitKind,
} from '../../api/generated/models';
import {
  approveWorkingGroupProject,
  getPreviewWorkingGroupProjectRequestUrl,
  previewWorkingGroupProjectRequest,
  putWorkingGroupFinanceSignature,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { useCurrentUser } from '../auth/auth';
import { formatMoney } from '../orders/formatting';
import { formatCents, fromCents, moneyInputText, parseMoneyInput, toCents } from '../orders/money';
import { FilePreview, Shell } from './PurchaseDialogs';
import { budgetOptions, financeRulesOptions } from './financeQueries';
import { requestAttachments } from './projectModel';
import { SignatureField, type SignatureValue } from './SignatureField';
import { useDialogOpener } from './useDialogOpener';
import { taskErrorText, useWgMutation } from './useWgMutation';

const UNIT_KINDS: { id: WorkingGroupProjectUnitKind; label: string }[] = [
  { id: 'stv', label: 'Stv' },
  { id: 'uv', label: 'UV' },
  { id: 'referat', label: 'Referat, Studi-Lab' },
];

interface FormValues {
  unitKind: WorkingGroupProjectUnitKind;
  unitName: string;
  projectName: string;
  startsOn: string;
  endsOn: string;
  description: string;
  people: string;
  maxExpenses: string;
  maxIncome: string;
  alcohol: boolean;
  advance: boolean;
  responsibleFirstName: string;
  responsibleLastName: string;
  place: string;
  date: string;
}

/** The approval of a project by a finance manager: where the money comes from and, for the WiRef, the whole Projektantrag. */
export function ApproveDialog({ project, onClose }: { project: WorkingGroupProject; onClose: () => void }) {
  const me = useCurrentUser();
  const rules = useQuery(financeRulesOptions);
  const budget = useQuery(budgetOptions({}));
  const free = budget.data?.groups.find((entry) => entry.groupId === project.groupId)?.free;
  const [paidFrom, setPaidFrom] = useState<WorkingGroupProjectPaidFrom>(project.paidFrom ?? 'group');
  const [signature, setSignature] = useState<SignatureValue>(null);
  const [savedAvailable, setSavedAvailable] = useState(false);
  const [keep, setKeep] = useState(false);
  const preview = useDialogOpener<{ key: string; body: WorkingGroupProjectRequestFormInput }>();
  const defaults = project.requestForm;
  const threshold = rules.data?.projectThreshold;
  const needsWiRef =
    paidFrom === 'external' ||
    project.wirefNeeded ||
    (threshold !== undefined && toCents(project.totals.planned) >= toCents(threshold));
  const offersMissing = project.items.filter((item) => item.needsOffers && item.offers.length < 3);
  const attachments = requestAttachments(project);

  const { control, register, handleSubmit, getValues } = useForm<FormValues>({
    defaultValues: {
      unitKind: defaults?.unitKind ?? rules.data?.request?.unitKind ?? 'stv',
      unitName: defaults?.unitName ?? rules.data?.request?.unitName ?? '',
      projectName: defaults?.projectName ?? project.title,
      startsOn: defaults?.startsOn ?? project.startsOn ?? '',
      endsOn: defaults?.endsOn ?? project.endsOn ?? '',
      description: defaults?.description ?? project.goal,
      people: String(defaults?.people ?? project.people),
      maxExpenses: moneyInputText(toCents(defaults?.maxExpenses ?? project.totals.planned)),
      maxIncome: moneyInputText(toCents(defaults?.maxIncome ?? project.plannedIncome)),
      alcohol: defaults?.alcohol ?? project.alcohol,
      advance: defaults?.advance ?? project.advanceRequested,
      responsibleFirstName: defaults?.responsibleFirstName ?? '',
      responsibleLastName: defaults?.responsibleLastName ?? '',
      place: defaults?.place ?? rules.data?.request?.place ?? '',
      date: defaults?.date ?? new Date().toISOString().slice(0, 10),
    },
  });

  const formBody = (values: FormValues): WorkingGroupProjectRequestFormInput => ({
    unitKind: values.unitKind,
    unitName: values.unitName.trim(),
    projectName: values.projectName.trim(),
    startsOn: values.startsOn || undefined,
    endsOn: values.endsOn || undefined,
    description: values.description.trim(),
    people: Number(values.people),
    maxExpenses: fromCents(parseMoneyInput(values.maxExpenses) ?? 0),
    maxIncome: fromCents(parseMoneyInput(values.maxIncome) ?? 0),
    alcohol: values.alcohol,
    advance: values.advance,
    responsibleFirstName: values.responsibleFirstName.trim(),
    responsibleLastName: values.responsibleLastName.trim(),
    place: values.place.trim(),
    date: values.date,
    ...(signature && 'png' in signature ? { signature: signature.png } : {}),
    ...(signature && 'useSaved' in signature ? { useSavedSignature: true } : {}),
  });

  const approve = useWgMutation(async (values: FormValues) => {
    if (needsWiRef && keep && signature && 'png' in signature) {
      const bytes = Uint8Array.from(atob(signature.png), (c) => c.charCodeAt(0));
      await putWorkingGroupFinanceSignature(new Blob([bytes], { type: 'image/png' }));
    }
    await approveWorkingGroupProject(project.id, {
      expectedVersion: project.version,
      paidFrom,
      ...(needsWiRef ? { form: formBody(values) } : {}),
    });
  });
  const submit = handleSubmit((values) => approve.mutate(values, { onSuccess: onClose }));
  const sender = `${me.person.firstName} ${me.person.lastName}`;

  return (
    <>
      <Shell
        heading="Approve the project"
        label={project.groupName}
        primary={needsWiRef ? 'Approve and send to the WiRef' : 'Approve'}
        size="md"
        pending={approve.isPending}
        error={
          approve.isError ? taskErrorText(approve.error, 'It could not be approved. Check the fields.') : undefined
        }
        onClose={onClose}
        onSubmit={() => void submit()}
      >
        <RadioButtonGroup
          legendText="Paid from"
          name="wg-approve-paid-from"
          orientation="vertical"
          valueSelected={paidFrom}
          helperText="Can be changed later."
          onChange={(value) => setPaidFrom(value as WorkingGroupProjectPaidFrom)}
        >
          <RadioButton
            id="wg-paid-group"
            value="group"
            labelText={`Group budget${free ? ` — ${formatMoney(free)} free` : ''}`}
          />
          <RadioButton
            id="wg-paid-external"
            value="external"
            labelText="External source — For example from HTU. Always goes to the WiRef."
          />
        </RadioButtonGroup>

        {needsWiRef && (
          <>
            <dl className="wg-pa-facts">
              <dt>To</dt>
              <dd>WiRef</dd>
              <dt>Subject</dt>
              <dd>Projektantrag: {project.title}</dd>
              <dt>From</dt>
              <dd>{sender}</dd>
              <dt>Amount</dt>
              <dd>{formatCents(toCents(project.totals.planned))}</dd>
            </dl>
            <div>
              <p className="wg-pa-label">Attachments</p>
              {attachments.length === 0 ? (
                <p className="wg-muted">No files attached.</p>
              ) : (
                <ul className="wg-pa-attachments">
                  {attachments.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>
            {offersMissing.length > 0 && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Offers are missing"
                subtitle={offersMissing.map((item) => item.text).join(', ')}
              />
            )}

            <div className="wg-pa-grid">
              <Controller
                control={control}
                name="unitKind"
                render={({ field }) => (
                  <Select
                    id="wg-pa-kind"
                    labelText="Kind of unit"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                  >
                    {UNIT_KINDS.map((kind) => (
                      <SelectItem key={kind.id} value={kind.id} text={kind.label} />
                    ))}
                  </Select>
                )}
              />
              <TextInput id="wg-pa-unit" labelText="Name of the unit" {...register('unitName')} />
              <TextInput id="wg-pa-name" labelText="Project name" {...register('projectName')} />
              <Controller
                control={control}
                name="startsOn"
                render={({ field }) => (
                  <DateInput id="wg-pa-from" labelText="From" value={field.value} onChange={field.onChange} />
                )}
              />
              <Controller
                control={control}
                name="endsOn"
                render={({ field }) => (
                  <DateInput id="wg-pa-until" labelText="Until" value={field.value} onChange={field.onChange} />
                )}
              />
              <TextInput id="wg-pa-people" labelText="People" inputMode="numeric" {...register('people')} />
              <TextInput
                id="wg-pa-expenses"
                labelText="Planned maximum expenses"
                inputMode="decimal"
                {...register('maxExpenses')}
              />
              <TextInput
                id="wg-pa-income"
                labelText="Planned maximum income"
                inputMode="decimal"
                {...register('maxIncome')}
              />
              <TextInput
                id="wg-pa-first"
                labelText="Kostenstellenverantwortliche Person, first name"
                {...register('responsibleFirstName')}
              />
              <TextInput
                id="wg-pa-last"
                labelText="Kostenstellenverantwortliche Person, last name"
                {...register('responsibleLastName')}
              />
              <TextInput id="wg-pa-place" labelText="Place" {...register('place')} />
              <Controller
                control={control}
                name="date"
                render={({ field }) => (
                  <DateInput id="wg-pa-date" labelText="Date" value={field.value} onChange={field.onChange} />
                )}
              />
            </div>
            <TextArea id="wg-pa-description" labelText="Description" rows={3} {...register('description')} />
            <Controller
              control={control}
              name="alcohol"
              render={({ field }) => (
                <Checkbox
                  id="wg-pa-alcohol"
                  labelText="Alcohol is served"
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
            <Controller
              control={control}
              name="advance"
              render={({ field }) => (
                <Checkbox
                  id="wg-pa-advance"
                  labelText="Ask HTU for an advance"
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />

            <SignatureField onChange={setSignature} onSavedAvailable={setSavedAvailable} />
            {!savedAvailable || (signature && 'png' in signature) ? (
              <Checkbox
                id="wg-pa-keep"
                labelText="Keep this signature for my next requests"
                checked={keep}
                disabled={!signature || !('png' in signature)}
                onChange={(_, { checked }) => setKeep(checked)}
              />
            ) : null}
            <div>
              <Button
                kind="tertiary"
                size="md"
                onClick={() => preview.open({ key: String(Date.now()), body: formBody(getValues()) })}
              >
                Preview the form
              </Button>
            </div>
          </>
        )}
      </Shell>
      {preview.value && (
        <FilePreview
          title="Projektantrag"
          cacheKey={`preview-${project.id}-${preview.value.key}`}
          load={() => previewWorkingGroupProjectRequest(project.id, preview.value!.body)}
          downloadUrl={getPreviewWorkingGroupProjectRequestUrl(project.id)}
          onClose={preview.close}
        />
      )}
    </>
  );
}
