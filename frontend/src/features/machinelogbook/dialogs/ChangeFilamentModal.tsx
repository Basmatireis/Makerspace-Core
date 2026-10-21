import { useEffect, useState } from 'react';
import { Controller, FormProvider, useFieldArray, useForm } from 'react-hook-form';
import {
  Button, Checkbox, CheckboxGroup, ComboBox, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, ProgressIndicator, ProgressStep,
  RadioButton, RadioButtonGroup, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper, TextInput,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { changeFilamentSpoolFill } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentNewFillInputSource, FilamentSpool, FilamentSpoolIdentifierKind, InventoryTransactionKind } from '../../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { LeftoverFields, leftoverDefaults, leftoverSummary, resolveLeftover, saveTareWeight, toLeftoverInput, type LeftoverValues } from '../components/LeftoverFields';
import { formatGrams, toDecimal, TransactionKindTag } from '../components/inventoryShared';
import { identifierKey, identifierKinds, identifierLabel, initialOf, needsRefill, remainingOf, spoolNameText, toNumber } from '../components/spoolShared';
import { closeMaterialDelta, planClose } from '../fillPlan';
import { formatDateTime } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { allSpoolsQuery, filamentMaterialsQuery, spoolErrorMessage, useRefreshInventory } from '../spoolData';

type Values = LeftoverValues & {
  spoolId: string;
  materialId: string; netWeight: string; source: FilamentNewFillInputSource; price: string; supplier: string; manufacturer: string; product: string;
  keep: Record<string, boolean>;
  added: { kind: FilamentSpoolIdentifierKind; value: string }[];
};

type StepKey = 'spool' | 'leftover' | 'filament' | 'tags';
const LABELS: Record<StepKey, string> = { spool: 'Spool', leftover: 'Leftover', filament: 'New filament', tags: 'Tags' };
const STEP_FIELDS: Record<StepKey, (keyof Values)[]> = {
  spool: ['spoolId'], leftover: ['grossWeight', 'tareWeight'], filament: ['materialId', 'netWeight', 'price', 'source'], tags: [],
};

const blankTag = (): Values['added'][number] => ({ kind: 'nfc', value: '' });
/** NFC tags are replaced with every refill; barcodes and QR codes stay on the spool. */
const keepDefaults = (spool: FilamentSpool | undefined) => Object.fromEntries((spool?.identifiers ?? []).map((item) => [item.id, item.kind !== 'nfc']));

/** Narrow screens stack the steps vertically. */
function useNarrow() {
  const query = '(max-width: 41.98rem)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

const entryText = (kind: InventoryTransactionKind, quantity: number, spool: string) => {
  const amount = formatGrams(Math.abs(quantity));
  if (kind === 'spool_transfer') return quantity >= 0 ? `${amount} loose stock → ${spool}` : `${amount} ${spool} → loose stock`;
  return `${quantity > 0 ? '+' : '−'}${amount}`;
};

/** Refill workflow: choose a spool, say what happens with its leftover, load the new filament and replace the tags. */
export function ChangeFilamentModal({ open, onClose, spool: preselected }: { open: boolean; onClose: () => void; spool?: FilamentSpool }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const narrow = useNarrow();
  const can = useCan();
  const [step, setStep] = useState(0);
  const canPurchase = can('inventory.manage');
  const spoolList = useQuery({ ...allSpoolsQuery({ kind: 'reusable', lifecycle: 'active' }), enabled: open });
  const materialList = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const ready = spoolList.isSuccess && materialList.isSuccess;
  const loadFailed = spoolList.isError || materialList.isError;
  const choices = spoolList.data ?? [];
  const filaments = (materialList.data ?? []).filter((material) => material.active);
  /** Refilling the same filament is the common case, so the spool's current filament is preselected. */
  const defaults = (spool: FilamentSpool | undefined): Values => {
    const filled = Boolean(spool && !needsRefill(spool) && filaments.some((item) => item.id === spool.materialId));
    const material = filled ? filaments.find((item) => item.id === spool?.materialId) : undefined;
    return {
      ...leftoverDefaults(spool), spoolId: spool?.id ?? '',
      materialId: material?.id ?? '', netWeight: material?.packageSize != null ? decimalText(material.packageSize) : '1000', source: 'loose_stock', price: '', supplier: '',
      manufacturer: filled ? spool?.manufacturer ?? '' : '', product: filled ? spool?.productName ?? '' : '', keep: keepDefaults(spool), added: [blankTag()],
    };
  };
  const form = useForm<Values>({ defaultValues: defaults(preselected) });
  const { control, register, handleSubmit, reset, setValue, getValues, trigger, formState: { errors } } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'added' });
  const values = form.watch();
  const spool = preselected && preselected.id === values.spoolId ? preselected : choices.find((item) => item.id === values.spoolId);
  const refillOnly = spool ? needsRefill(spool) : false;
  const steps: StepKey[] = ['spool', ...(refillOnly ? [] : ['leftover' as const]), 'filament', 'tags'];
  const current = steps[Math.min(step, steps.length - 1)] ?? 'spool';
  const last = step >= steps.length - 1;

  const mutation = useMutation({
    mutationFn: async (data: Values) => {
      if (!spool || !material) throw new Error('spool or material missing');
      const version = refillOnly ? spool.version : await saveTareWeight(spool, data);
      return changeFilamentSpoolFill(spool.id, {
        leftover: refillOnly ? null : toLeftoverInput(spool, data),
        fill: {
          materialId: material.id, manufacturer: data.manufacturer.trim() || null, productName: data.product.trim() || null,
          netWeightG: toDecimal(decimalNumber(data.netWeight) ?? 0), source: data.source, totalPrice: data.source === 'purchase' && decimalNumber(data.price) !== null ? toDecimal(decimalNumber(data.price) ?? 0) : null, supplier: data.supplier.trim() || null,
        },
        keepIdentifierIds: spool.identifiers.filter((item) => data.keep[item.id]).map((item) => item.id),
        newIdentifiers: data.added.filter((item) => item.value.trim()).map((item) => ({ kind: item.kind, value: item.value.trim() })),
        occurredAt: new Date().toISOString(), expectedVersion: version,
      });
    },
  });
  const pending = mutation.isPending;

  useEffect(() => {
    if (!open || !ready) return;
    reset(defaults(preselected));
    mutation.reset();
    setStep(preselected ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, preselected?.id]);

  const chooseSpool = (next: FilamentSpool | null) => {
    setValue('spoolId', next?.id ?? '', { shouldValidate: Boolean(next) });
    const fresh = defaults(next ?? undefined);
    for (const key of ['leftoverBasis', 'grossWeight', 'tareWeight', 'leftoverOutcome', 'materialId', 'netWeight', 'manufacturer', 'product', 'keep'] as const) setValue(key, fresh[key]);
  };

  const leftover = spool && !refillOnly ? resolveLeftover(spool, values) : null;
  const material = filaments.find((item) => item.id === values.materialId);
  const net = decimalNumber(values.netWeight) ?? 0;

  // Loose stock after the old fill has been closed: a returned leftover joins it, corrections and disposals leave the material.
  const stockAfterClose = (materialId: string) => {
    const target = filaments.find((item) => item.id === materialId);
    if (!target) return { total: 0, loose: 0 };
    const sameMaterial = Boolean(spool && !needsRefill(spool) && spool.materialId === materialId);
    const delta = spool && leftover && sameMaterial ? closeMaterialDelta({ remainingQuantity: remainingOf(spool), fillNumber: spool.fillNumber }, leftover.choice) : 0;
    const total = Math.round((toNumber(target.quantity) + delta) * 1000) / 1000;
    const others = toNumber(target.assignedQuantity) - (spool && sameMaterial ? remainingOf(spool) : 0);
    return { total, loose: Math.max(0, total - others) };
  };
  const stock = material ? stockAfterClose(material.id) : { total: 0, loose: 0 };

  const sourceHelper = !material ? 'Choose a material to see the effect on its stock.'
    : values.source === 'loose_stock'
      ? `Moves ${formatGrams(net)} from loose stock to this spool. The material total stays ${formatGrams(stock.total)}. ${formatGrams(stock.loose)} of loose stock is available.`
      : `Adds ${formatGrams(net)} to ${material.name} stock (new total ${formatGrams(stock.total + net)}) and records the purchase.`;

  const taken = (kind: string, value: string, index: number) => {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    if (choices.some((item) => item.id !== values.spoolId && item.identifiers.some((identifier) => identifierKey(identifier.kind, identifier.value) === identifierKey(kind, text)))) return 'This identifier is already assigned to another spool.';
    if ((spool?.identifiers ?? []).some((identifier) => values.keep[identifier.id] && identifierKey(identifier.kind, identifier.value) === identifierKey(kind, text))) return 'This identifier is already kept on this spool.';
    if (getValues('added').some((item, other) => other !== index && identifierKey(item.kind, item.value) === identifierKey(kind, text))) return 'This identifier is entered twice.';
    return null;
  };

  const kept = (spool?.identifiers ?? []).filter((item) => values.keep[item.id]);
  const dropped = (spool?.identifiers ?? []).filter((item) => !values.keep[item.id]);
  const added = values.added.filter((item) => item.value.trim());
  const closing = spool && leftover ? planClose({ remainingQuantity: remainingOf(spool), fillNumber: spool.fillNumber }, leftover.choice) : [];
  const nextFill = (spool?.fillNumber ?? 0) + 1;
  const name = spool ? spoolNameText(spool) : 'spool';
  const review = [
    ...(spool && leftover ? [{
      key: 'close', change: `Close fill ${spool.fillNumber}`,
      detail: `${spool.materialName}: used ${formatGrams(Math.max(0, initialOf(spool) - leftover.choice.leftoverG))}, ${leftover.choice.leftoverG > 0
        ? `leftover ${formatGrams(leftover.choice.leftoverG)} ${leftover.choice.outcome === 'returned_to_stock' ? 'returned to loose stock' : 'disposed'}` : 'nothing left'}`,
    }] : []),
    ...closing.map((entry, index) => ({ key: `c${index}`, change: <TransactionKindTag kind={entry.kind} />, detail: `${entryText(entry.kind, entry.quantity, spool?.displayId ?? '')} · ${entry.note}` })),
    { key: 'open', change: `Start fill ${nextFill}`, detail: material ? `${material.name}, ${formatGrams(net)}${[values.manufacturer, values.product].filter((item) => item.trim()).length ? `, ${[values.manufacturer, values.product].filter((item) => item.trim()).join(' ')}` : ''}` : 'No material chosen' },
    ...(material ? [{
      key: 'open-entry', change: <TransactionKindTag kind={values.source === 'purchase' ? 'purchase' : 'spool_transfer'} />,
      detail: values.source === 'purchase'
        ? `+${formatGrams(net)} bought${decimalNumber(values.price) !== null ? ` for ${(decimalNumber(values.price) ?? 0).toFixed(2)} €` : ''}, booked to ${name}`
        : `${entryText('spool_transfer', net, spool?.displayId ?? '')}, total unchanged`,
    }] : []),
    {
      key: 'tags', change: 'Tags',
      detail: [`Keep ${kept.length === 0 ? 'none' : kept.map((item) => item.value).join(', ')}`, dropped.length ? `Remove ${dropped.map((item) => item.value).join(', ')}` : null, added.length ? `Add ${added.map((item) => `${identifierLabel(item.kind)} ${item.value.trim()}`).join(', ')}` : null].filter(Boolean).join(' · '),
    },
  ];

  const next = async () => {
    if (!(await trigger(STEP_FIELDS[current]))) return;
    setStep((value) => value + 1);
  };

  const submit = handleSubmit(async (data) => {
    if (!spool || !material) return;
    let result: FilamentSpool;
    try {
      result = await mutation.mutateAsync(data);
    } catch {
      await refresh();
      return;
    }
    await refresh();
    notify({ kind: 'success', title: `${spool.displayId} refilled with ${material.name} (fill ${result.fillNumber})` });
    onClose();
  });

  return (
    <ComposedModal open={open} size="lg" preventCloseOnClickOutside onClose={() => { if (!pending) onClose(); }} aria-label="Change filament">
      <ModalHeader title="Change filament" label={spool ? spoolNameText(spool) : 'Spools'} />
      <ModalBody hasForm>
        <FormProvider {...form}>
          <form onSubmit={(event) => { event.preventDefault(); void (last ? submit() : next()); }} noValidate>
            <Stack gap={7}>
              <ProgressIndicator
                currentIndex={Math.min(step, steps.length - 1)} vertical={narrow} spaceEqually={!narrow}
                onChange={(index: number) => { if (index < step && !pending) setStep(index); }}
              >
                {steps.map((key) => <ProgressStep key={key} label={LABELS[key]} />)}
              </ProgressIndicator>

              {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={spoolErrorMessage(mutation.error)} />}
              {loadFailed && <ErrorState message="Spools and filament could not be loaded." onRetry={() => { void spoolList.refetch(); void materialList.refetch(); }} />}
              {!ready && !loadFailed && <InlineLoadingState label="Loading spools and filament" />}

              {ready && current === 'spool' && (
                <Controller
                  control={control} name="spoolId" rules={{ required: 'Choose a spool.' }}
                  render={({ fieldState }) => (
                    <ComboBox<FilamentSpool>
                      id="refill-spool" titleText="Spool" placeholder="Search by ID, label, material or tag" items={choices}
                      helperText="Reusable spools only. Scan or type a tag value to find a spool."
                      itemToString={(item) => item ? `${spoolNameText(item)} · ${needsRefill(item) ? 'Needs refill' : item.materialName}` : ''}
                      shouldFilterItem={({ item, inputValue }) => {
                        const text = (inputValue ?? '').trim().toLowerCase();
                        if (!item || !text) return true;
                        return [item.displayId, item.label, item.materialName, ...item.identifiers.map((identifier) => identifier.value)].filter(Boolean).join(' ').toLowerCase().includes(text);
                      }}
                      selectedItem={spool ? choices.find((item) => item.id === spool.id) ?? null : null} onChange={({ selectedItem }) => chooseSpool(selectedItem ?? null)}
                      invalid={fieldState.invalid} invalidText={fieldState.error?.message}
                    />
                  )}
                />
              )}

              {ready && current === 'leftover' && spool && (
                <Stack gap={6}>
                  <dl className="mj-facts">
                    <div><dt>Current fill</dt><dd>{spool.materialName} · fill {spool.fillNumber}{spool.filledAt ? ` · since ${formatDateTime(spool.filledAt)}` : ''}</dd></div>
                    <div><dt>Expected remaining</dt><dd>{formatGrams(remainingOf(spool))} of {formatGrams(initialOf(spool))}</dd></div>
                  </dl>
                  <LeftoverFields spool={spool} idPrefix="refill" />
                </Stack>
              )}

              {ready && current === 'filament' && (
                <Stack gap={6}>
                  {refillOnly && <InlineNotification kind="info" lowContrast hideCloseButton title="Needs refill" subtitle={`${name} has no filament. The new fill is fill ${nextFill}.`} />}
                  <Select
                    id="refill-material" labelText="Filament" invalid={Boolean(errors.materialId)} invalidText={errors.materialId?.message}
                    {...register('materialId', { required: 'Choose a filament.', onChange: (event) => { const next = filaments.find((item) => item.id === event.target.value); if (next?.packageSize != null) setValue('netWeight', decimalText(next.packageSize)); } })}
                  >
                    <SelectItem value="" text="Choose a filament" />
                    {filaments.map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}
                  </Select>
                  <Controller
                    control={control} name="netWeight"
                    rules={{
                      validate: (value, form) => {
                        const valid = decimalValidator({ positive: true, requiredMessage: 'Enter a weight above zero.' })(value);
                        if (valid !== true) return valid;
                        const target = filaments.find((item) => item.id === form.materialId);
                        return form.source === 'loose_stock' && target && (decimalNumber(value) ?? 0) > stockAfterClose(target.id).loose ? `Only ${formatGrams(stockAfterClose(target.id).loose)} of loose stock is available.` : true;
                      },
                    }}
                    render={({ field, fieldState }) => (
                      <DecimalField
                        id="refill-weight" labelText="Net weight of the new filament (g)" helperText="Filament without the spool."
                        value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message} onChange={field.onChange}
                      />
                    )}
                  />
                  <Controller
                    control={control} name="source"
                    render={({ field }) => (
                      <RadioButtonGroup legendText="Where does the filament come from?" name="refill-source" orientation="vertical" valueSelected={field.value} helperText={sourceHelper} onChange={(value) => field.onChange(value)}>
                        <RadioButton id="refill-source-stock" value="loose_stock" labelText={`From loose stock${material ? ` (${formatGrams(stock.loose)} available)` : ''}`} />
                        <RadioButton id="refill-source-purchase" value="purchase" disabled={!canPurchase} labelText={canPurchase ? 'New purchase' : 'New purchase (needs the inventory.manage permission)'} />
                      </RadioButtonGroup>
                    )}
                  />
                  {values.source === 'purchase' && (
                    <>
                      <Controller
                        control={control} name="price" rules={{ validate: (value, form) => form.source !== 'purchase' || decimalValidator({ places: 2, requiredMessage: 'Enter the total price, zero or more.' })(value) }}
                        render={({ field, fieldState }) => (
                          <DecimalField
                            id="refill-price" labelText="Total price (€)" helperText="Updates the average acquisition cost."
                            value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message} onChange={field.onChange}
                          />
                        )}
                      />
                      <TextInput id="refill-supplier" labelText="Supplier (optional)" autoComplete="off" {...register('supplier')} />
                    </>
                  )}
                  <TextInput id="refill-manufacturer" labelText="Manufacturer (optional)" helperText="Defaults to the manufacturer of the article." autoComplete="off" {...register('manufacturer')} />
                  <TextInput id="refill-product" labelText="Product name (optional)" autoComplete="off" {...register('product')} />
                </Stack>
              )}

              {ready && current === 'tags' && spool && (
                <Stack gap={6}>
                  {spool.identifiers.length > 0 ? (
                    <Controller
                      control={control} name="keep"
                      render={({ field }) => (
                        <CheckboxGroup legendText="Keep on this spool" helperText="Unchecked tags stay in the history of the old fill. NFC tags are replaced with every refill.">
                          {spool.identifiers.map((identifier) => (
                            <Checkbox
                              key={identifier.id} id={`refill-keep-${identifier.id}`} labelText={`${identifierLabel(identifier.kind)} ${identifier.value}`}
                              checked={Boolean(field.value[identifier.id])} onChange={(_event, { checked }) => field.onChange({ ...field.value, [identifier.id]: checked })}
                            />
                          ))}
                        </CheckboxGroup>
                      )}
                    />
                  ) : <p className="mj-secondary">This spool has no identifiers yet.</p>}
                  <fieldset className="mj-fieldset">
                    <legend className="cds--label">New identifiers</legend>
                    <Stack gap={5}>
                      {fields.map((field, index) => (
                        <div className="mj-identifier-row" key={field.id}>
                          <Select id={`refill-tag-kind-${index}`} labelText="Kind" {...register(`added.${index}.kind`)}>
                            {identifierKinds.map((kind) => <SelectItem key={kind.id} value={kind.id} text={kind.label} />)}
                          </Select>
                          <TextInput
                            id={`refill-tag-value-${index}`} labelText="Value" autoComplete="off" helperText={index === 0 ? 'As printed or read by the scanner. Leave empty to add no tag.' : undefined}
                            invalid={Boolean(errors.added?.[index]?.value)} invalidText={errors.added?.[index]?.value?.message}
                            {...register(`added.${index}.value`, { validate: (value, form) => taken(form.added[index]?.kind ?? 'nfc', value, index) ?? true })}
                          />
                          <Button hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription={`Remove identifier row ${index + 1}`} tooltipPosition="left" onClick={() => remove(index)} />
                        </div>
                      ))}
                      <div><Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => append(blankTag())}>Add identifier</Button></div>
                    </Stack>
                  </fieldset>
                  <section aria-labelledby="refill-review-title">
                    <h3 id="refill-review-title" className="cds--label">Review</h3>
                    <StructuredListWrapper isCondensed aria-label="Changes that will be saved">
                      <StructuredListHead>
                        <StructuredListRow head>
                          <StructuredListCell head>Change</StructuredListCell>
                          <StructuredListCell head>Details</StructuredListCell>
                        </StructuredListRow>
                      </StructuredListHead>
                      <StructuredListBody>
                        {review.map((row) => (
                          <StructuredListRow key={row.key}>
                            <StructuredListCell noWrap>{row.change}</StructuredListCell>
                            <StructuredListCell>{row.detail}</StructuredListCell>
                          </StructuredListRow>
                        ))}
                      </StructuredListBody>
                    </StructuredListWrapper>
                    {leftover?.complete && leftover.choice.basis === 'weighed' && <p className="mj-secondary">{leftoverSummary(spool, leftover.choice)}</p>}
                    {material && <p className="mj-secondary">{material.name} total after saving: {formatGrams(values.source === 'purchase' ? stock.total + net : stock.total)}.</p>}
                  </section>
                </Stack>
              )}
            </Stack>
          </form>
        </FormProvider>
      </ModalBody>
      <ModalFooter
        primaryButtonText={last ? (pending ? 'Saving…' : 'Save') : 'Next'} primaryButtonDisabled={pending || !ready || (current === 'spool' && !values.spoolId)}
        {...(step > 0
          ? { secondaryButtons: [{ buttonText: 'Cancel', onClick: () => { if (!pending) onClose(); } }, { buttonText: 'Back', onClick: () => { if (!pending) setStep((value) => Math.max(0, value - 1)); } }] as [{ buttonText: string; onClick: () => void }, { buttonText: string; onClick: () => void }] }
          : { secondaryButtonText: 'Cancel', onRequestClose: () => { if (!pending) onClose(); } })}
        onRequestSubmit={() => { void (last ? submit() : next()); }}
      >{null}</ModalFooter>
    </ComposedModal>
  );
}
