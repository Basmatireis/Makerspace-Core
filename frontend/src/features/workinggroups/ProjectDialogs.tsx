import { useRef, useState } from 'react';
import { Button, Checkbox, Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import { Attachment } from '@carbon/icons-react';
import { Controller, useForm } from 'react-hook-form';
import type { WorkingGroupProject, WorkingGroupProjectItem, WorkingGroupSummary } from '../../api/generated/models';
import {
  completeWorkingGroupProject,
  createWorkingGroupProject,
  createWorkingGroupProjectItem,
  createWorkingGroupProjectOffer,
  declineWorkingGroupProject,
  recordWorkingGroupProjectWiRefDecision,
  returnWorkingGroupProject,
  updateWorkingGroupProject,
  updateWorkingGroupProjectItem,
  uploadWorkingGroupProjectOfferFile,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { fromCents, moneyInputText, parseMoneyInput, toCents } from '../orders/money';
import { formatMoney } from '../orders/formatting';
import { ACCEPTED_FILES, fileProblem } from './financeModel';
import { Shell } from './PurchaseDialogs';
import { taskErrorText, useWgMutation } from './useWgMutation';

const moneyRule = (value: string) => parseMoneyInput(value) !== null || 'Enter an amount.';

interface ProjectValues {
  groupId: string;
  title: string;
  goal: string;
  benefit: string;
  startsOn: string;
  endsOn: string;
  people: string;
  plannedIncome: string;
  alcohol: boolean;
  advanceRequested: boolean;
  advanceAmount: string;
}

/** "Start a project" and "Edit": no cost plan and no "Paid from" here. */
export function ProjectDialog({
  groups,
  initialGroupId,
  project,
  onClose,
  onSaved,
}: {
  groups: readonly WorkingGroupSummary[];
  initialGroupId: string;
  project?: WorkingGroupProject;
  onClose: () => void;
  onSaved?: (project: WorkingGroupProject) => void;
}) {
  const { control, register, handleSubmit, watch, formState } = useForm<ProjectValues>({
    defaultValues: {
      groupId: project?.groupId ?? (initialGroupId || groups[0]?.id || ''),
      title: project?.title ?? '',
      goal: project?.goal ?? '',
      benefit: project?.benefit ?? '',
      startsOn: project?.startsOn ?? '',
      endsOn: project?.endsOn ?? '',
      people: String(project?.people ?? 1),
      plannedIncome: moneyInputText(toCents(project?.plannedIncome ?? '0')),
      alcohol: project?.alcohol ?? false,
      advanceRequested: project?.advanceRequested ?? false,
      advanceAmount: project?.advanceAmount ? moneyInputText(toCents(project.advanceAmount)) : '',
    },
  });
  const advance = watch('advanceRequested');
  const save = useWgMutation(async (values: ProjectValues) => {
    const body = {
      title: values.title.trim(),
      goal: values.goal.trim(),
      benefit: values.benefit.trim(),
      startsOn: values.startsOn || null,
      endsOn: values.endsOn || null,
      people: Number(values.people),
      plannedIncome: fromCents(parseMoneyInput(values.plannedIncome) ?? 0),
      alcohol: values.alcohol,
      advanceRequested: values.advanceRequested,
      advanceAmount:
        values.advanceRequested && values.advanceAmount.trim() !== ''
          ? fromCents(parseMoneyInput(values.advanceAmount) ?? 0)
          : null,
    };
    const saved = project
      ? await updateWorkingGroupProject(project.id, { ...body, expectedVersion: project.version })
      : await createWorkingGroupProject({ ...body, groupId: values.groupId });
    onSaved?.(saved);
  });
  const submit = handleSubmit((values) => save.mutate(values, { onSuccess: onClose }));
  return (
    <Shell
      heading={project ? 'Edit project' : 'Start a project'}
      primary="Save"
      size="md"
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'Check the fields and try again.') : undefined}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {!project && groups.length > 1 && (
        <Select id="wg-pj-group" labelText="Working group" {...register('groupId')}>
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id} text={group.name} />
          ))}
        </Select>
      )}
      <TextInput
        id="wg-pj-title"
        labelText="Title"
        invalid={Boolean(formState.errors.title)}
        invalidText={formState.errors.title?.message}
        {...register('title', { validate: (v) => v.trim() !== '' || 'Enter a title.' })}
      />
      <TextArea id="wg-pj-goal" labelText="What we want to do" rows={3} {...register('goal')} />
      <TextArea id="wg-pj-benefit" labelText="What it improves" rows={3} {...register('benefit')} />
      <Controller
        control={control}
        name="startsOn"
        render={({ field }) => (
          <DateInput id="wg-pj-from" labelText="From" value={field.value} onChange={field.onChange} />
        )}
      />
      <Controller
        control={control}
        name="endsOn"
        render={({ field }) => (
          <DateInput id="wg-pj-until" labelText="Until" value={field.value} onChange={field.onChange} />
        )}
      />
      <TextInput
        id="wg-pj-people"
        labelText="People taking part"
        inputMode="numeric"
        invalid={Boolean(formState.errors.people)}
        invalidText={formState.errors.people?.message}
        {...register('people', {
          validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0) || 'Enter a whole number.',
        })}
      />
      <TextInput
        id="wg-pj-income"
        labelText="Planned income"
        inputMode="decimal"
        invalid={Boolean(formState.errors.plannedIncome)}
        invalidText={formState.errors.plannedIncome?.message}
        {...register('plannedIncome', { validate: moneyRule })}
      />
      <Controller
        control={control}
        name="alcohol"
        render={({ field }) => (
          <Checkbox
            id="wg-pj-alcohol"
            labelText="Alcohol is served"
            checked={field.value}
            onChange={(_, { checked }) => field.onChange(checked)}
          />
        )}
      />
      <Controller
        control={control}
        name="advanceRequested"
        render={({ field }) => (
          <Checkbox
            id="wg-pj-advance"
            labelText="Ask HTU for an advance"
            checked={field.value}
            onChange={(_, { checked }) => field.onChange(checked)}
          />
        )}
      />
      {advance && (
        <TextInput
          id="wg-pj-advance-amount"
          labelText="Advance amount"
          helperText="Empty = whole planned amount."
          inputMode="decimal"
          invalid={Boolean(formState.errors.advanceAmount)}
          invalidText={formState.errors.advanceAmount?.message}
          {...register('advanceAmount', {
            validate: (v) => v.trim() === '' || parseMoneyInput(v) !== null || 'Enter an amount.',
          })}
        />
      )}
    </Shell>
  );
}

interface ItemValues {
  text: string;
  amount: string;
  link: string;
  note: string;
}

export function ItemDialog({
  project,
  item,
  onClose,
}: {
  project: WorkingGroupProject;
  item?: WorkingGroupProjectItem;
  onClose: () => void;
}) {
  const { register, handleSubmit, formState } = useForm<ItemValues>({
    defaultValues: {
      text: item?.text ?? '',
      amount: item ? moneyInputText(toCents(item.plannedAmount)) : '',
      link: item?.link ?? '',
      note: item?.note ?? '',
    },
  });
  const save = useWgMutation((values: ItemValues) => {
    const body = {
      text: values.text.trim(),
      plannedAmount: fromCents(parseMoneyInput(values.amount) ?? 0),
      link: values.link.trim() || undefined,
      note: values.note.trim() || undefined,
    };
    return item
      ? updateWorkingGroupProjectItem(project.id, item.id, { ...body, expectedVersion: project.version })
      : createWorkingGroupProjectItem(project.id, body);
  });
  const submit = handleSubmit((values) => save.mutate(values, { onSuccess: onClose }));
  return (
    <Shell
      heading={item ? 'Edit item' : 'Add item'}
      primary="Save"
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'Check the fields and try again.') : undefined}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextInput
        id="wg-item-text"
        labelText="Item"
        invalid={Boolean(formState.errors.text)}
        invalidText={formState.errors.text?.message}
        {...register('text', { validate: (v) => v.trim() !== '' || 'Enter the item.' })}
      />
      <TextInput
        id="wg-item-amount"
        labelText="Planned cost"
        helperText="In total, not per piece."
        inputMode="decimal"
        invalid={Boolean(formState.errors.amount)}
        invalidText={formState.errors.amount?.message}
        {...register('amount', { validate: moneyRule })}
      />
      <TextInput id="wg-item-link" labelText="Link" {...register('link')} />
      <TextArea id="wg-item-note" labelText="Note" rows={2} {...register('note')} />
    </Shell>
  );
}

export function OfferDialog({
  project,
  item,
  onClose,
}: {
  project: WorkingGroupProject;
  item: WorkingGroupProjectItem;
  onClose: () => void;
}) {
  const [shop, setShop] = useState('');
  const [price, setPrice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cents = parseMoneyInput(price);
  const save = useWgMutation(async () => {
    const saved = await createWorkingGroupProjectOffer(project.id, item.id, {
      expectedVersion: project.version,
      shop: shop.trim(),
      price: fromCents(cents ?? 0),
    });
    if (file) {
      const offer = saved.items
        .find((i) => i.id === item.id)
        ?.offers.find((o) => !item.offers.some((x) => x.id === o.id));
      if (offer) {
        await uploadWorkingGroupProjectOfferFile(project.id, offer.id, file, {
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        });
      }
    }
  });
  const problem = fileProblem(file);
  return (
    <Shell
      heading="Add an offer"
      primary="Add"
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'The offer was not saved.') : undefined}
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (shop.trim() !== '' && cents !== null && cents > 0 && !problem)
          save.mutate(undefined, { onSuccess: onClose });
      }}
    >
      <p>{item.text}</p>
      <TextInput
        id="wg-offer-shop"
        labelText="Shop"
        value={shop}
        invalid={touched && shop.trim() === ''}
        invalidText="Enter the shop."
        onChange={(e) => setShop(e.target.value)}
      />
      <TextInput
        id="wg-offer-price"
        labelText="Price"
        inputMode="decimal"
        value={price}
        invalid={touched && (cents === null || cents <= 0)}
        invalidText="Enter the price."
        onChange={(e) => setPrice(e.target.value)}
      />
      <div>
        <input
          ref={input}
          type="file"
          className="wg-visually-hidden"
          tabIndex={-1}
          accept={ACCEPTED_FILES}
          aria-label="Offer file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button kind="tertiary" size="md" renderIcon={Attachment} onClick={() => input.current?.click()}>
          {file ? file.name : 'Choose the offer file'}
        </Button>
        {problem && <p className="wg-buyrow__error">{problem}</p>}
      </div>
    </Shell>
  );
}

/** "Return with a comment" and "Decline": the reason is required. */
export function ReasonDialog({
  project,
  mode,
  onClose,
}: {
  project: WorkingGroupProject;
  mode: 'return' | 'decline' | 'wiref-decline';
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useWgMutation(() => {
    const body = { expectedVersion: project.version, reason: reason.trim() };
    return mode === 'return'
      ? returnWorkingGroupProject(project.id, body)
      : declineWorkingGroupProject(project.id, body);
  });
  const heading = { return: 'Return with a comment', decline: 'Decline', 'wiref-decline': 'The WiRef declined it' }[
    mode
  ];
  return (
    <Shell
      heading={heading}
      primary={mode === 'return' ? 'Return' : 'Decline'}
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'It could not be saved. Reload and try again.') : undefined}
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (reason.trim() !== '') save.mutate(undefined, { onSuccess: onClose });
      }}
    >
      <p>{project.title}</p>
      <TextArea
        id="wg-pj-reason"
        labelText={mode === 'return' ? 'Comment' : 'Reason'}
        rows={3}
        maxCount={500}
        enableCounter={false}
        value={reason}
        invalid={touched && reason.trim() === ''}
        invalidText="Write a reason."
        onChange={(e) => setReason(e.target.value)}
      />
    </Shell>
  );
}

/** "WiRef approved it": the number and, per item that needs offers, the offer the WiRef chose. */
export function WiRefDecisionDialog({ project, onClose }: { project: WorkingGroupProject; onClose: () => void }) {
  const [number, setNumber] = useState(project.wirefNumber ?? '');
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(project.items.filter((i) => i.chosenOfferId).map((i) => [i.id, i.chosenOfferId as string])),
  );
  const [touched, setTouched] = useState(false);
  const needing = project.items.filter((item) => item.needsOffers);
  const missing = needing.some((item) => !chosen[item.id]);
  const save = useWgMutation(() =>
    recordWorkingGroupProjectWiRefDecision(project.id, {
      expectedVersion: project.version,
      number: number.trim(),
      chosenOffers: needing.map((item) => ({ itemId: item.id, offerId: chosen[item.id] })),
    }),
  );
  return (
    <Shell
      heading="WiRef approved it"
      primary="Save"
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'It could not be saved. Check the fields.') : undefined}
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (number.trim() !== '' && !missing) save.mutate(undefined, { onSuccess: onClose });
      }}
    >
      <TextInput
        id="wg-wiref-number"
        labelText="WiRef number"
        value={number}
        invalid={touched && number.trim() === ''}
        invalidText="Enter the number."
        onChange={(e) => setNumber(e.target.value)}
      />
      {needing.map((item) => (
        <Select
          key={item.id}
          id={`wg-wiref-offer-${item.id}`}
          labelText={`Offer for ${item.text}`}
          value={chosen[item.id] ?? ''}
          invalid={touched && !chosen[item.id]}
          invalidText="Choose an offer."
          onChange={(e) => setChosen({ ...chosen, [item.id]: e.target.value })}
        >
          <SelectItem value="" text="Choose an offer" />
          {item.offers.map((offer) => (
            <SelectItem key={offer.id} value={offer.id} text={`${offer.shop} · ${formatMoney(offer.price)}`} />
          ))}
        </Select>
      ))}
    </Shell>
  );
}

export function CompleteDialog({ project, onClose }: { project: WorkingGroupProject; onClose: () => void }) {
  const [report, setReport] = useState(project.completionReport ?? '');
  const save = useWgMutation(() =>
    completeWorkingGroupProject(project.id, { expectedVersion: project.version, report: report.trim() || undefined }),
  );
  return (
    <Shell
      heading="Complete the project"
      primary="Complete"
      pending={save.isPending}
      error={save.isError ? taskErrorText(save.error, 'It could not be completed.') : undefined}
      onClose={onClose}
      onSubmit={() => save.mutate(undefined, { onSuccess: onClose })}
    >
      <TextArea
        id="wg-pj-report"
        labelText="Report"
        rows={5}
        maxCount={2000}
        enableCounter={false}
        value={report}
        onChange={(e) => setReport(e.target.value)}
      />
    </Shell>
  );
}
