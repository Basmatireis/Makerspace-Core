import { useEffect } from 'react';
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form';
import {
  Button,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextArea,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { DetectedSpoolTag, FilamentSpool, Material } from '../../../api/generated/models';
import { mountPrinterSpool } from '../../../api/generated/printing/printing';
import { FuzzyComboBox } from '../../../app/components/FuzzyComboBox';
import { dateInAppTimeZone, zonedDateTimeToISO } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { ArticleFields, blankArticle, previewName, type ArticleValues } from '../components/ArticleFields';
import { DetectedTagPicker } from '../components/DetectedTagPicker';
import { formatGrams, toDecimal, toMoney } from '../components/inventoryShared';
import { spoolLabelPrefix, trayIdentifier, trayIdentityDisplay, type TrayIdentifier } from '../components/spoolShared';
import { useNewFilamentArticle } from '../components/useNewFilamentArticle';
import { detectedGrams, detectedSlotText, suggestArticle } from '../detectedSpools';
import { materialTypesQuery } from '../inventoryQueries';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { errorCode, filamentMaterialsQuery, spoolErrorMessage, useRefreshInventory } from '../spoolData';

type Origin = 'existing_stock' | 'new_acquisition';
type Values = {
  materialId: string;
  /** Register onto a filament article that is created on save instead of an existing one. */
  newArticle: boolean;
  article: ArticleValues;
  origin: Origin;
  weight: string;
  price: string;
  supplier: string;
  acquiredOn: string;
  reference: string;
  tare: string;
  location: string;
  notes: string;
  nfcTag: string;
  nfcKind: TrayIdentifier['kind'];
  mount: boolean;
};

type Item = { id: string; label: string; isNew?: boolean };
const NEW_ITEM: Item = { id: '__new__', label: 'New article…', isNew: true };
const itemLabel = (material: Material) =>
  `${material.displayId} · ${material.name} · ${formatGrams(material.unassignedQuantity)} loose`;

/**
 * Registers one spool of a filament article: from loose stock (a zero-value transfer) or as a new purchase. Opened from
 * a tag a printer detects, it suggests the article, takes the tag and the reported remainder, and can mount the spool
 * in the slot the printer reports.
 */
export function RegisterSpoolModal({
  open,
  onClose,
  initialMaterialId,
  detected,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  initialMaterialId?: string;
  detected?: DetectedSpoolTag;
  onRegistered?: (spool: FilamentSpool) => void;
}) {
  const can = useCan();
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const newArticle = useNewFilamentArticle();
  const canCreateArticle = can('inventory.manage');
  const canMount = can('printer_slots.assign') && Boolean(detected?.slotId);
  const materials = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const types = useQuery({ ...materialTypesQuery(), enabled: open && Boolean(detected) });
  const choices = (materials.data ?? []).filter((item) => item.active);
  const suggestion = detected ? suggestArticle(detected, choices, types.data ?? []) : null;
  const today = dateInAppTimeZone(new Date());

  const detectedId = trayIdentifier(detected);
  const detectedIdentity = trayIdentityDisplay(detected);

  const defaults = (): Values => {
    const initial = choices.find((item) => item.id === initialMaterialId) ?? suggestion?.article ?? undefined;
    const reported = detected ? detectedGrams(detected, Number(initial?.packageSize ?? 0)) : null;
    return {
      materialId: initial?.id ?? '',
      newArticle: Boolean(detected && !initial && canCreateArticle && types.isSuccess),
      article: {
        ...blankArticle('filament', suggestion?.type?.id ?? ''),
        variant: suggestion?.variant ?? '',
        colorName: suggestion?.colorName ?? '',
        colorHex: suggestion?.colorHex ?? '',
        packageSize: '1000',
      },
      origin: initial && Number(initial.unassignedQuantity) > 0 ? 'existing_stock' : 'new_acquisition',
      weight: decimalText(reported ?? (initial?.packageSize != null ? Number(initial.packageSize) : 1000)),
      price: '',
      supplier: '',
      acquiredOn: today,
      reference: '',
      tare: '',
      location: initial?.storageLocation ?? '',
      notes: '',
      nfcTag: detectedId?.value ?? '',
      nfcKind: detectedId?.kind ?? 'nfc',
      mount: canMount,
    };
  };
  const form = useForm<Values>({ defaultValues: defaults() });
  const { control, register, handleSubmit, reset, setValue, setError, clearErrors } = form;
  const values = useWatch({ control }) as Values;
  const chosen = values.newArticle ? undefined : choices.find((item) => item.id === values.materialId);
  const loose = chosen ? Number(chosen.unassignedQuantity) : 0;
  const origin: Origin = values.newArticle || loose <= 0 ? 'new_acquisition' : values.origin;
  const weight = decimalNumber(values.weight) ?? 0;

  const save = useMutation({
    mutationFn: async (data: Values) => {
      const material = data.newArticle ? await newArticle.ensure(data.article) : chosen;
      if (!material) throw new Error('article missing');
      const tare = decimalNumber(data.tare);
      const tag = data.nfcTag.trim();
      const spool = await createFilamentSpool({
        materialId: material.id,
        initialNetWeightG: toDecimal(decimalNumber(data.weight) ?? 0),
        stockMode: origin,
        ...(origin === 'new_acquisition'
          ? {
              totalPrice: toMoney(decimalNumber(data.price, { places: 2 }) ?? 0),
              supplier: data.supplier.trim() || null,
            }
          : {}),
        tareWeightG: tare == null ? null : toDecimal(tare),
        acquiredOn: data.acquiredOn || null,
        acquisitionReference: data.reference.trim() || null,
        storageLocation: data.location.trim() || null,
        notes: data.notes.trim() || null,
        occurredAt: data.acquiredOn === today ? new Date().toISOString() : zonedDateTimeToISO(data.acquiredOn, '12:00'),
        expectedInventoryVersion: material.inventoryVersion,
        identifiers: tag ? [{ kind: data.nfcKind, value: tag }] : undefined,
      });
      // The spool exists from here on; a refused mount is reported but does not undo the registration.
      let mountError: unknown = null;
      if (data.mount && canMount && detected?.slotId) {
        try {
          await mountPrinterSpool(detected.slotId, { spoolId: spool.id });
        } catch (error) {
          mountError = error;
        }
      }
      return { spool, mountError };
    },
    onError: (error) => {
      if (errorCode(error) === 'identifier_in_use')
        setError('nfcTag', { message: 'This tag is already assigned to a spool.' });
      void refresh();
    },
  });

  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
    newArticle.reset();
  });
  // Defaults depend on the loaded articles and types (the suggestion), so the form resets once they are there.
  const ready = materials.isSuccess && (!detected || types.isSuccess || types.isError);
  useEffect(() => {
    if (open && ready) resetForm();
  }, [open, ready, initialMaterialId, detectedId?.value, resetForm]);

  const submit = handleSubmit(async (data) => {
    let result;
    try {
      result = await save.mutateAsync(data);
    } catch {
      return;
    }
    await refresh();
    const { spool, mountError } = result;
    notify(
      mountError
        ? {
            kind: 'warning',
            title: `${spool.displayId} registered, not mounted`,
            subtitle: spoolErrorMessage(mountError, 'Mount it from the printer setup.'),
          }
        : {
            kind: 'success',
            title: `${spool.displayId} registered`,
            subtitle: `${spool.materialName}${data.mount && canMount && detected ? ` · mounted in ${detectedSlotText(detected)}` : ''}`,
            link: { label: `Open ${spool.displayId}`, to: machineLogbookPaths.spool(spool.id) },
          },
    );
    onRegistered?.(spool);
    onClose();
  });

  const items: Item[] = [
    ...(canCreateArticle ? [NEW_ITEM] : []),
    ...choices.map((item) => ({ id: item.id, label: itemLabel(item) })),
  ];
  const selectedItem = values.newArticle ? NEW_ITEM : (items.find((item) => item.id === values.materialId) ?? null);
  const pending = save.isPending;
  const failure = save.isError && errorCode(save.error) !== 'identifier_in_use' ? save.error : null;
  const labelPreview = chosen
    ? `${spoolLabelPrefix(chosen)}-NN`
    : values.newArticle && suggestion?.type
      ? `${spoolLabelPrefix({ materialTypeCode: suggestion.type.code, variant: values.article?.variant, colorName: values.article?.colorName })}-NN`
      : null;
  const newName = values.newArticle ? previewName(values.article, 'filament', undefined) : '';

  return (
    <Modal
      open={open}
      size="lg"
      modalLabel={detected ? `Detected in ${detectedSlotText(detected)}` : undefined}
      modalHeading="Register spool"
      primaryButtonText={pending ? 'Saving…' : values.mount && canMount ? 'Register and mount' : 'Register spool'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !materials.isSuccess}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
      }}
    >
      <FormProvider {...form}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <Stack gap={6}>
            {detected && (
              <dl className="inv-summary">
                <dt>Printer reports</dt>
                <dd>
                  <span className="mj-inline">
                    {detected.colorHex && (
                      <span
                        className="inv-swatch"
                        style={{ backgroundColor: `#${detected.colorHex}` }}
                        role="img"
                        aria-label={`Reported colour #${detected.colorHex}`}
                      />
                    )}
                    {[
                      detected.subBrand ?? detected.materialType,
                      detected.colorHex ? `#${detected.colorHex}` : null,
                      suggestion?.colorName,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    {detected.remainPercent != null ? ` · ${detected.remainPercent} % remaining` : ''}
                  </span>
                </dd>
                <dt>{detectedIdentity?.label ?? 'RFID'}</dt>
                <dd className="mj-inline-mono" title={detectedIdentity?.value}>
                  {detectedIdentity?.value}
                </dd>
              </dl>
            )}
            {failure && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="The spool was not registered"
                subtitle={spoolErrorMessage(failure)}
              />
            )}
            {materials.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Not loaded"
                subtitle="Filament articles could not be loaded. Close the dialog and try again."
              />
            )}
            <FuzzyComboBox<Item>
              autoAlign
              id="register-article"
              titleText="Article"
              items={items}
              itemToString={(item) => item?.label ?? ''}
              selectedItem={selectedItem}
              placeholder="Search filament articles"
              helperText={
                detected && suggestion?.article && values.materialId === suggestion.article.id
                  ? suggestion.match === 'similar'
                    ? 'Suggested from what the printer reports; its colour only resembles the reported one. Check it.'
                    : 'Suggested from what the printer reports; check it.'
                  : detected && values.newArticle
                    ? 'No article matches the reported filament; the new one is prefilled from the report.'
                    : undefined
              }
              invalid={Boolean(form.formState.errors.materialId)}
              invalidText={form.formState.errors.materialId?.message}
              onChange={({ selectedItem: next }) => {
                clearErrors('materialId');
                if (!next) return;
                if (next.isNew) {
                  setValue('newArticle', true);
                  setValue('materialId', '');
                  return;
                }
                const found = choices.find((item) => item.id === next.id);
                setValue('newArticle', false);
                setValue('materialId', next.id);
                if (found) {
                  setValue('origin', Number(found.unassignedQuantity) > 0 ? 'existing_stock' : 'new_acquisition');
                  if (!values.location) setValue('location', found.storageLocation ?? '');
                  if (!detected && found.packageSize != null) setValue('weight', decimalText(found.packageSize));
                }
              }}
            />
            <input
              type="hidden"
              {...register('materialId', {
                validate: (value, all) => all.newArticle || Boolean(value) || 'Choose a filament article.',
              })}
            />
            {values.newArticle && (
              <Stack gap={6}>
                {newArticle.created ? (
                  <InlineNotification
                    kind="success"
                    lowContrast
                    hideCloseButton
                    title="Filament article created"
                    subtitle={`${newArticle.created.name} exists now. Save again to register the spool.`}
                  />
                ) : (
                  <ArticleFields kind="filament" idPrefix="register-new" reportedColorHex={detected?.colorHex} />
                )}
                <div>
                  <Button kind="ghost" size="sm" onClick={() => setValue('newArticle', false)}>
                    Use an existing article
                  </Button>
                </div>
              </Stack>
            )}
            <Controller
              control={control}
              name="origin"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="Stock origin"
                  name="register-origin"
                  orientation="vertical"
                  valueSelected={origin}
                  onChange={(value) => field.onChange(value)}
                >
                  <RadioButton
                    id="register-origin-loose"
                    value="existing_stock"
                    disabled={values.newArticle || loose <= 0}
                    labelText={
                      chosen && loose > 0
                        ? `From loose stock (${formatGrams(loose)} loose; the total does not change)`
                        : 'From loose stock (none available)'
                    }
                  />
                  <RadioButton
                    id="register-origin-purchase"
                    value="new_acquisition"
                    labelText="New purchase (booked onto this spool)"
                  />
                </RadioButtonGroup>
              )}
            />
            <div className="mj-form-row">
              <Controller
                control={control}
                name="weight"
                rules={{
                  validate: (value) => {
                    const valid = decimalValidator({ positive: true, requiredMessage: 'Enter the net weight.' })(value);
                    if (valid !== true) return valid;
                    return origin === 'existing_stock' && (decimalNumber(value) ?? 0) > loose
                      ? `Only ${formatGrams(loose)} are loose. Choose New purchase for the rest.`
                      : true;
                  },
                }}
                render={({ field, fieldState }) => (
                  <DecimalField
                    id="register-weight"
                    labelText="Filament on the spool in g (net)"
                    helperText={
                      detected?.remainPercent != null
                        ? `${detected.remainPercent} % of the package as reported; weigh later to correct.`
                        : 'The package size, or the weighed net amount of a started spool.'
                    }
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                    invalidText={fieldState.error?.message}
                  />
                )}
              />
              <Controller
                control={control}
                name="tare"
                rules={{ validate: decimalValidator({ optional: true }) }}
                render={({ field, fieldState }) => (
                  <DecimalField
                    id="register-tare"
                    labelText="Tare weight in g (optional)"
                    helperText="The empty spool, for weighing."
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                    invalidText={fieldState.error?.message}
                  />
                )}
              />
            </div>
            {origin === 'new_acquisition' && (
              <div className="mj-form-row">
                <Controller
                  control={control}
                  name="price"
                  rules={{
                    validate: decimalValidator({ places: 2, requiredMessage: 'Enter the price, zero or more.' }),
                  }}
                  render={({ field, fieldState }) => (
                    <DecimalField
                      id="register-price"
                      labelText="Price in EUR"
                      helperText="What this spool cost."
                      value={field.value}
                      onChange={field.onChange}
                      invalid={fieldState.invalid}
                      invalidText={fieldState.error?.message}
                    />
                  )}
                />
                <TextInput
                  id="register-supplier"
                  labelText="Supplier (optional)"
                  autoComplete="off"
                  maxLength={200}
                  {...register('supplier')}
                />
              </div>
            )}
            <div className="mj-form-row">
              <Controller
                control={control}
                name="acquiredOn"
                rules={{
                  validate: (value) =>
                    !value ? 'Enter the date.' : value > today ? 'The date cannot be in the future.' : true,
                }}
                render={({ field, fieldState }) => (
                  <DateInput
                    id="register-date"
                    labelText="Acquired on"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                    invalidText={fieldState.error?.message}
                    required
                  />
                )}
              />
              <TextInput
                id="register-reference"
                labelText="Reference (optional)"
                helperText="Invoice or order number."
                autoComplete="off"
                maxLength={200}
                {...register('reference')}
              />
            </div>
            <div className="mj-form-row">
              <TextInput
                id="register-nfc"
                labelText={
                  values.nfcKind === 'bambu_tray_uuid' ? 'Bambu spool identifier (optional)' : 'RFID tag UID (optional)'
                }
                helperText={detected ? 'Read by the printer.' : 'Lets printers recognise the spool.'}
                autoComplete="off"
                maxLength={255}
                readOnly={Boolean(detected)}
                invalid={Boolean(form.formState.errors.nfcTag)}
                invalidText={form.formState.errors.nfcTag?.message}
                {...register('nfcTag')}
              />
              {detected && canMount ? (
                <Controller
                  control={control}
                  name="mount"
                  render={({ field }) => (
                    <Toggle
                      id="register-mount"
                      labelText="Mount"
                      labelA="Leave unmounted"
                      labelB={`Mounted in ${detectedSlotText(detected)}`}
                      toggled={field.value}
                      onToggle={(checked) => field.onChange(checked)}
                    />
                  )}
                />
              ) : (
                <TextInput
                  id="register-location"
                  labelText="Storage location (optional)"
                  autoComplete="off"
                  maxLength={200}
                  {...register('location')}
                />
              )}
            </div>
            {!detected && (
              <DetectedTagPicker
                id="register-detected-tag"
                open={open}
                onPick={(identifier) => {
                  setValue('nfcTag', identifier.value, { shouldDirty: true });
                  setValue('nfcKind', identifier.kind, { shouldDirty: true });
                }}
              />
            )}
            <TextArea
              id="register-notes"
              labelText="Notes (optional)"
              rows={2}
              maxLength={2000}
              {...register('notes')}
            />
            <p className="inv-calc" aria-live="polite">
              {chosen || values.newArticle
                ? `${labelPreview ? `Spool ${labelPreview}` : 'The spool'} with ${formatGrams(weight)}${
                    origin === 'existing_stock'
                      ? ` moved from loose stock (${formatGrams(Math.max(0, loose - weight))} stay loose)`
                      : ` booked as a purchase${values.newArticle && newName ? ` of the new article ${newName}` : ''}`
                  }. The number is assigned on saving.`
                : 'Choose the article the spool holds.'}
            </p>
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
