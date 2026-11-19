import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  FormGroup,
  IconButton,
  InlineNotification,
  Link,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, Attachment, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import type { WorkingGroupPurchase, WorkingGroupPurchaseHow, WorkingGroupSummary } from '../../api/generated/models';
import {
  createWorkingGroupPurchases,
  declineWorkingGroupPurchase,
  handInWorkingGroupPurchaseReceipt,
  uploadWorkingGroupPurchaseAttachment,
} from '../../api/generated/working-groups/working-groups';
import { useNotify } from '../../app/toasts';
import { formatCents, fromCents, parseMoneyInput } from '../orders/money';
import { ACCEPTED_FILES, fileHeaders, fileProblem, previewKind } from './financeModel';
import { workingGroupKeys } from './queries';
import { taskErrorText, useWgMutation } from './useWgMutation';

export function Shell({
  heading,
  primary,
  pending,
  error,
  size = 'sm',
  onClose,
  onSubmit,
  children,
}: {
  heading: string;
  primary: string;
  pending: boolean;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      size={size}
      modalHeading={heading}
      primaryButtonText={pending ? 'Saving…' : primary}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={onSubmit}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Stack gap={6}>
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
          {children}
        </Stack>
      </form>
    </Modal>
  );
}

interface ItemValues {
  item: string;
  link: string;
  quantity: string;
  price: string;
  file: File | null;
}

interface AddValues {
  groupId: string;
  how: WorkingGroupPurchaseHow;
  items: ItemValues[];
}

const blankItem = (): ItemValues => ({ item: '', link: '', quantity: '1', price: '', file: null });

/** Several wanted items in one go, each with an optional offer or cart file that is attached after they exist. */
export function AddPurchasesDialog({
  groups,
  initialGroupId,
  onClose,
}: {
  groups: readonly WorkingGroupSummary[];
  initialGroupId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const fileInputs = useRef(new Map<number, HTMLInputElement>());
  const { control, handleSubmit, register, watch, setValue } = useForm<AddValues>({
    defaultValues: { groupId: initialGroupId || groups[0]?.id || '', how: 'central', items: [blankItem()] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const items = watch('items');
  const total = items.reduce((sum, row) => {
    const quantity = Number(row.quantity);
    const price = parseMoneyInput(row.price);
    return Number.isInteger(quantity) && quantity > 0 && price !== null ? sum + quantity * price : sum;
  }, 0);

  const notAttached = useRef<string[]>([]);
  const create = useWgMutation(async (values: AddValues) => {
    const created = await createWorkingGroupPurchases({
      groupId: values.groupId,
      how: values.how,
      items: values.items.map((row) => ({
        item: row.item.trim(),
        link: row.link.trim() || undefined,
        quantity: Number(row.quantity),
        unitPrice: fromCents(parseMoneyInput(row.price) ?? 0),
      })),
    });
    notAttached.current = [];
    for (const [index, row] of values.items.entries()) {
      const purchase = created.items[index];
      if (!row.file || !purchase) continue;
      try {
        await uploadWorkingGroupPurchaseAttachment(purchase.id, row.file, { headers: fileHeaders(row.file) });
      } catch {
        notAttached.current.push(row.item.trim());
      }
    }
  });
  const submit = handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        notify(
          notAttached.current.length > 0
            ? { kind: 'warning', title: 'Added without a file', subtitle: notAttached.current.join(', ') }
            : { kind: 'success', title: values.items.length === 1 ? 'Purchase added' : 'Purchases added' },
        );
        onClose();
      },
    }),
  );

  return (
    <Shell
      heading="Add purchases"
      primary={items.length > 1 ? `Add ${items.length} items` : 'Add'}
      pending={create.isPending}
      error={create.isError ? taskErrorText(create.error, 'Check the fields and try again.') : undefined}
      size="lg"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {groups.length > 1 && (
        <Select id="wg-buy-group" labelText="Working group" {...register('groupId')}>
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id} text={group.name} />
          ))}
        </Select>
      )}
      <FormGroup legendText="Items">
        <Stack gap={5}>
          {fields.map((field, index) => (
            <div key={field.id} className="wg-buyrow">
              <TextInput
                id={`wg-buy-item-${field.id}`}
                labelText="Item"
                hideLabel={index > 0}
                {...register(`items.${index}.item`, { validate: (value) => value.trim() !== '' || 'Enter the item.' })}
              />
              <TextInput
                id={`wg-buy-link-${field.id}`}
                labelText="Link to the shop"
                hideLabel={index > 0}
                {...register(`items.${index}.link`)}
              />
              <TextInput
                id={`wg-buy-qty-${field.id}`}
                labelText="Amount"
                hideLabel={index > 0}
                inputMode="numeric"
                {...register(`items.${index}.quantity`, {
                  validate: (value) =>
                    (Number.isInteger(Number(value)) && Number(value) > 0) || 'Enter a whole number.',
                })}
              />
              <TextInput
                id={`wg-buy-price-${field.id}`}
                labelText="Price each"
                hideLabel={index > 0}
                inputMode="decimal"
                {...register(`items.${index}.price`, {
                  validate: (value) => {
                    const cents = parseMoneyInput(value);
                    return (cents !== null && cents > 0) || 'Enter a price.';
                  },
                })}
              />
              <Controller
                control={control}
                name={`items.${index}.file`}
                rules={{ validate: (value) => fileProblem(value) ?? true }}
                render={({ field: fileField, fieldState }) => (
                  <div className="wg-buyrow__file">
                    <input
                      ref={(element) => {
                        if (element) fileInputs.current.set(index, element);
                        else fileInputs.current.delete(index);
                      }}
                      type="file"
                      className="wg-visually-hidden"
                      tabIndex={-1}
                      accept={ACCEPTED_FILES}
                      aria-label={`File for item ${index + 1}`}
                      onChange={(event) => {
                        fileField.onChange(event.target.files?.[0] ?? null);
                        event.target.value = '';
                      }}
                    />
                    <IconButton
                      kind={fileField.value ? 'secondary' : 'ghost'}
                      size="md"
                      label={fileField.value ? `Remove ${fileField.value.name}` : 'Attach a file'}
                      aria-pressed={Boolean(fileField.value)}
                      onClick={() =>
                        fileField.value ? fileField.onChange(null) : fileInputs.current.get(index)?.click()
                      }
                    >
                      <Attachment />
                    </IconButton>
                    {fieldState.error && <p className="wg-buyrow__error">{fieldState.error.message}</p>}
                  </div>
                )}
              />
              <IconButton
                kind="ghost"
                size="md"
                label="Remove item"
                disabled={fields.length === 1}
                onClick={() => remove(index)}
              >
                <TrashCan />
              </IconButton>
            </div>
          ))}
          <div className="wg-buytotal">
            <Button kind="ghost" size="md" renderIcon={Add} onClick={() => append(blankItem())}>
              Add another item
            </Button>
            <span>
              Estimated total <strong>{formatCents(total)}</strong>
            </span>
          </div>
        </Stack>
      </FormGroup>
      <Controller
        control={control}
        name="how"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Who buys it?"
            name="wg-buy-how"
            orientation="vertical"
            valueSelected={field.value}
            onChange={(value) => {
              field.onChange(value);
              setValue('how', value as WorkingGroupPurchaseHow);
            }}
          >
            <RadioButton id="wg-buy-central" value="central" labelText="Management, with the next collective order" />
            <RadioButton id="wg-buy-self" value="self" labelText="I buy it myself. You get the money back." />
          </RadioButtonGroup>
        )}
      />
    </Shell>
  );
}

export function DeclineDialog({ purchase, onClose }: { purchase: WorkingGroupPurchase; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const decline = useWgMutation(() =>
    declineWorkingGroupPurchase(purchase.id, {
      expectedVersion: purchase.version,
      reason: reason.trim() || undefined,
    }),
  );
  return (
    <Shell
      heading="Decline purchase"
      primary="Decline"
      pending={decline.isPending}
      error={
        decline.isError ? taskErrorText(decline.error, 'It could not be declined. Reload and try again.') : undefined
      }
      onClose={onClose}
      onSubmit={() => decline.mutate(undefined, { onSuccess: onClose })}
    >
      <p>{purchase.item}</p>
      <TextArea
        id="wg-decline-reason"
        labelText="Reason"
        rows={3}
        maxCount={500}
        enableCounter={false}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </Shell>
  );
}

export function ReceiptDialog({ purchase, onClose }: { purchase: WorkingGroupPurchase; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cents = parseMoneyInput(amount);
  const amountError = cents === null || cents <= 0 ? 'Enter the amount on the receipt.' : undefined;
  const fileError = !file ? 'Choose the receipt.' : fileProblem(file);
  const handIn = useWgMutation(() =>
    handInWorkingGroupPurchaseReceipt(purchase.id, file as File, {
      headers: {
        ...fileHeaders(file as File),
        'X-Receipt-Amount': fromCents(cents ?? 0),
        'X-Expected-Version': String(purchase.version),
      },
    }),
  );
  return (
    <Shell
      heading="Hand in the receipt"
      primary="Hand in"
      pending={handIn.isPending}
      error={
        handIn.isError ? taskErrorText(handIn.error, 'The receipt was not saved. Check it and try again.') : undefined
      }
      onClose={onClose}
      onSubmit={() => {
        setTouched(true);
        if (!amountError && !fileError) handIn.mutate(undefined, { onSuccess: onClose });
      }}
    >
      <p>{purchase.item}</p>
      <TextInput
        id="wg-receipt-amount"
        labelText="Amount on the receipt"
        inputMode="decimal"
        value={amount}
        invalid={touched && Boolean(amountError)}
        invalidText={amountError}
        onChange={(event) => setAmount(event.target.value)}
      />
      <div>
        <input
          ref={input}
          type="file"
          className="wg-visually-hidden"
          tabIndex={-1}
          accept={ACCEPTED_FILES}
          aria-label="Receipt file"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Button kind="tertiary" size="md" renderIcon={Attachment} onClick={() => input.current?.click()}>
          {file ? file.name : 'Choose the receipt'}
        </Button>
        {touched && fileError && <p className="wg-buyrow__error">{fileError}</p>}
      </div>
    </Shell>
  );
}

/** A stored file in a dialog: a PDF in a frame, an image as such, anything else only as a download. */
export function FilePreview({
  title,
  cacheKey,
  load,
  downloadUrl,
  onClose,
}: {
  title: string;
  cacheKey: string;
  load: (signal: AbortSignal) => Promise<Blob>;
  downloadUrl: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [...workingGroupKeys.all, 'file', cacheKey],
    queryFn: ({ signal }) => load(signal),
    staleTime: 60_000,
  });
  const blob = query.data;
  const kind = blob ? previewKind(blob.type) : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || !kind || typeof URL.createObjectURL !== 'function') return;
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob, kind]);
  return (
    <Modal open passiveModal size="lg" modalHeading={title} onRequestClose={onClose}>
      {query.isError ? (
        <InlineNotification kind="error" lowContrast hideCloseButton title="The file could not be loaded" />
      ) : !blob ? (
        <p className="wg-muted">Loading…</p>
      ) : kind === 'image' && url ? (
        <img className="wg-preview" src={url} alt={title} />
      ) : kind === 'pdf' && url ? (
        <iframe className="wg-preview wg-preview--pdf" src={url} title={title} />
      ) : (
        <p>
          This file cannot be shown here.{' '}
          <Link href={downloadUrl} download>
            Download it
          </Link>
        </p>
      )}
    </Modal>
  );
}
