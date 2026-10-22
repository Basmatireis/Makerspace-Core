import { useEffect } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import {
  Button,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  addFilamentSpoolIdentifier,
  createFilamentSpool,
  updateFilamentSpool,
} from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, FilamentSpoolKind } from '../../../api/generated/models';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { blankArticle, type ArticleValues } from '../components/ArticleFields';
import { DetectedTagPicker } from '../components/DetectedTagPicker';
import { NewFilamentArticle } from '../components/NewFilamentArticle';
import { useNewFilamentArticle } from '../components/useNewFilamentArticle';
import { formatGrams, parseDecimal, toDecimal, toMoney } from '../components/inventoryShared';
import { hasOpenFill, identifierKey, toNumber } from '../components/spoolShared';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import {
  errorCode,
  filamentMaterialsQuery,
  spoolErrorMessage,
  spoolUpdateBody,
  useRefreshInventory,
} from '../spoolData';

type Values = {
  kind: FilamentSpoolKind;
  label: string;
  materialId: string;
  /** Fill with a filament article that is created on save instead of an existing one. */
  newArticle: boolean;
  article: ArticleValues;
  price: string;
  supplier: string;
  weight: string;
  tare: string;
  manufacturer: string;
  product: string;
  location: string;
  firstFill: 'fill' | 'empty';
  acquiredOn: string;
  reference: string;
  notes: string;
  /** NFC tag of the current fill: tags a new spool, or is added to an edited one. */
  nfcTag: string;
};

const nonNegative = (value: string) =>
  !value.trim() || (parseDecimal(value) ?? -1) >= 0 || 'Enter a number of zero or more.';
const orNull = (value: string) => value.trim() || null;
const nfcIdentifiers = (values: Values) => {
  const tag = values.nfcTag.trim();
  return tag ? [{ kind: 'nfc' as const, value: tag }] : undefined;
};

/**
 * Registers a physical spool that already exists: it takes its filament from loose stock, or stays empty for a
 * reusable spool, or buys it together with a new filament article. With a spool, edits its descriptive fields.
 */
export function SpoolFormModal({
  open,
  onClose,
  spool,
  initialMaterialId,
}: {
  open: boolean;
  onClose: () => void;
  spool?: FilamentSpool;
  initialMaterialId?: string;
}) {
  const notify = useNotify();
  const canCreateArticle = useCan()('inventory.manage');
  const newArticle = useNewFilamentArticle();
  const refresh = useRefreshInventory();
  const materials = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const keptMaterialId = spool?.materialId ?? initialMaterialId;
  const choices = (materials.data ?? []).filter((material) => material.active || material.id === keptMaterialId);
  const defaults = (): Values => ({
    kind: spool?.kind ?? 'reusable',
    label: spool?.label ?? '',
    materialId: spool?.materialId ?? initialMaterialId ?? '',
    newArticle: false,
    article: blankArticle('filament'),
    price: '',
    supplier: '',
    weight: spool ? String(toNumber(spool.initialNetWeightG)) : '1000',
    tare: spool?.tareWeightG != null ? String(toNumber(spool.tareWeightG)) : '',
    manufacturer: spool?.manufacturer ?? '',
    product: spool?.productName ?? '',
    location: spool?.storageLocation ?? '',
    firstFill: 'fill',
    acquiredOn: spool?.acquiredOn ?? dateInAppTimeZone(new Date()),
    reference: spool?.acquisitionReference ?? '',
    notes: spool?.notes ?? '',
    nfcTag: '',
  });
  const form = useForm<Values>({ defaultValues: defaults() });
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = form;
  const adding = !spool && watch('newArticle');
  // Reusable spools can be registered empty; an existing spool without a current fill has nothing to edit about a fill.
  const showFill = spool ? hasOpenFill(spool) : watch('kind') === 'single_use' || watch('firstFill') === 'fill';
  const mutation = useMutation({
    mutationFn: async (values: Values) => {
      const tare = parseDecimal(values.tare);
      if (spool) {
        // The tag goes first: a refused tag leaves the spool unchanged, and a retry skips a tag already added.
        const tag = values.nfcTag.trim();
        if (
          tag &&
          hasOpenFill(spool) &&
          !spool.identifiers.some(
            (identifier) => identifierKey(identifier.kind, identifier.value) === identifierKey('nfc', tag),
          )
        )
          await addFilamentSpoolIdentifier(spool.id, { kind: 'nfc', value: tag });
        return updateFilamentSpool(
          spool.id,
          spoolUpdateBody(spool, {
            label: orNull(values.label),
            tareWeightG: tare == null ? null : toDecimal(tare),
            // The snapshot belongs to the open fill; a spool waiting for a refill has none to edit.
            ...(hasOpenFill(spool)
              ? { manufacturer: orNull(values.manufacturer), productName: orNull(values.product) }
              : {}),
            storageLocation: orNull(values.location),
            acquiredOn: values.acquiredOn || null,
            acquisitionReference: orNull(values.reference),
            notes: orNull(values.notes),
          }),
        );
      }
      if (!showFill) {
        // A reusable spool registered without a fill; Change filament starts its first fill later.
        return createFilamentSpool({
          kind: 'reusable',
          label: orNull(values.label),
          stockMode: 'empty',
          tareWeightG: tare == null ? null : toDecimal(tare),
          acquiredOn: values.acquiredOn || null,
          acquisitionReference: orNull(values.reference),
          storageLocation: orNull(values.location),
          notes: orNull(values.notes),
          occurredAt: new Date().toISOString(),
        });
      }
      if (values.newArticle) {
        // The article is created once; a retry after a failed registration reuses it.
        const article = await newArticle.ensure(values.article);
        return createFilamentSpool({
          kind: values.kind,
          label: orNull(values.label),
          materialId: article.id,
          initialNetWeightG: toDecimal(parseDecimal(values.weight) ?? 0),
          stockMode: 'new_acquisition',
          totalPrice: toMoney(parseDecimal(values.price) ?? 0),
          supplier: orNull(values.supplier),
          manufacturer: orNull(values.manufacturer),
          productName: orNull(values.product),
          tareWeightG: tare == null ? null : toDecimal(tare),
          acquiredOn: values.acquiredOn || null,
          acquisitionReference: orNull(values.reference),
          storageLocation: orNull(values.location),
          notes: orNull(values.notes),
          occurredAt: new Date().toISOString(),
          expectedInventoryVersion: article.inventoryVersion,
          identifiers: nfcIdentifiers(values),
        });
      }
      const material = choices.find((item) => item.id === values.materialId);
      if (!material) throw new Error('material missing');
      return createFilamentSpool({
        kind: values.kind,
        label: orNull(values.label),
        materialId: material.id,
        initialNetWeightG: toDecimal(parseDecimal(values.weight) ?? 0),
        stockMode: 'existing_stock',
        manufacturer: orNull(values.manufacturer),
        productName: orNull(values.product),
        tareWeightG: tare == null ? null : toDecimal(tare),
        acquiredOn: values.acquiredOn || null,
        acquisitionReference: orNull(values.reference),
        storageLocation: orNull(values.location),
        notes: orNull(values.notes),
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
        identifiers: nfcIdentifiers(values),
      });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    mutation.reset();
    newArticle.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, spool?.id, initialMaterialId, resetForm]);
  const pending = mutation.isPending;
  const selectedMaterial = choices.find((material) => material.id === watch('materialId'));
  const available = selectedMaterial ? toNumber(selectedMaterial.unassignedQuantity) : 0;
  const typedWeight = parseDecimal(watch('weight')) ?? 0;
  const effect = adding
    ? `Adds ${formatGrams(typedWeight)} of new filament to stock and records the purchase.`
    : selectedMaterial
      ? `Moves ${formatGrams(typedWeight)} from loose stock to this spool. The total stays ${formatGrams(toNumber(selectedMaterial.quantity))}; ${formatGrams(available)} is loose.`
      : undefined;
  const chooseNewArticle = (enabled: boolean) => {
    setValue('newArticle', enabled);
    setValue('materialId', '');
  };

  const submit = handleSubmit(async (values) => {
    let saved: FilamentSpool;
    try {
      saved = await mutation.mutateAsync(values);
    } catch (error) {
      if (errorCode(error) === 'identifier_in_use')
        setError('nfcTag', { message: 'This tag is already assigned to a spool.' });
      await refresh();
      return;
    }
    await refresh();
    notify({
      kind: 'success',
      title: spool ? 'Spool saved' : 'Spool registered',
      subtitle: `${saved.displayId}${saved.materialName ? ` · ${saved.materialName}` : ''}`,
    });
    onClose();
  });

  return (
    <Modal
      open={open}
      size="md"
      modalHeading={spool ? `Edit ${spool.displayId}` : 'Register spool'}
      primaryButtonText={pending ? 'Saving…' : spool ? 'Save spool' : 'Register spool'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || (!spool && !materials.isSuccess)}
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
            {!spool && (
              <p className="mj-secondary">
                Registers a spool you already have, using filament from loose stock, or a new spool you just bought with
                a new filament article.
              </p>
            )}
            {mutation.isError && errorCode(mutation.error) !== 'identifier_in_use' && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Not saved"
                subtitle={spoolErrorMessage(mutation.error)}
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
            {materials.isSuccess && choices.length === 0 && !spool && !canCreateArticle && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="No filament articles"
                subtitle="Receive filament stock first."
              />
            )}
            <Controller
              control={control}
              name="kind"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="Type"
                  name="spool-kind"
                  orientation="vertical"
                  valueSelected={field.value}
                  disabled={Boolean(spool)}
                  helperText={
                    field.value === 'reusable'
                      ? 'Refilled many times, e.g. a Bambu spool whose NFC tag changes with every refill.'
                      : 'Archived when finished; old archived spools can be cleaned up.'
                  }
                  onChange={(value) => field.onChange(value)}
                >
                  <RadioButton id="spool-kind-reusable" value="reusable" labelText="Reusable" />
                  <RadioButton id="spool-kind-single" value="single_use" labelText="Single-use" />
                </RadioButtonGroup>
              )}
            />
            <TextInput
              id="spool-label"
              labelText="Label (optional)"
              helperText="For example Bambu spool 03."
              autoComplete="off"
              maxLength={120}
              {...register('label')}
            />
            {!spool && watch('kind') === 'reusable' && (
              <Controller
                control={control}
                name="firstFill"
                render={({ field }) => (
                  <RadioButtonGroup
                    legendText="First fill"
                    name="spool-first-fill"
                    orientation="vertical"
                    valueSelected={field.value}
                    onChange={(value) => field.onChange(value)}
                  >
                    <RadioButton id="spool-first-fill-yes" value="fill" labelText="With filament from loose stock" />
                    <RadioButton
                      id="spool-first-fill-no"
                      value="empty"
                      labelText="Register empty and fill later (Change filament)"
                    />
                  </RadioButtonGroup>
                )}
              />
            )}
            {showFill && !adding && (
              <Select
                id="spool-material"
                labelText="Filament"
                disabled={Boolean(spool)}
                helperText={spool ? 'The article of a registered spool cannot change.' : undefined}
                invalid={Boolean(errors.materialId)}
                invalidText={errors.materialId?.message}
                {...register('materialId', {
                  validate: (value) => !showFill || Boolean(value) || 'Choose a filament.',
                })}
              >
                <SelectItem value="" text="Choose a filament" />
                {choices.map((material) => (
                  <SelectItem
                    key={material.id}
                    value={material.id}
                    text={material.active ? material.name : `${material.name} (inactive)`}
                  />
                ))}
              </Select>
            )}
            {showFill && !spool && canCreateArticle && !adding && (
              <Button kind="ghost" size="sm" onClick={() => chooseNewArticle(true)}>
                Add new filament
              </Button>
            )}
            {showFill && adding && (
              <NewFilamentArticle
                idPrefix="spool-article"
                created={newArticle.created}
                onUseExisting={() => chooseNewArticle(false)}
              />
            )}
            {showFill && (
              <TextInput
                id="spool-weight"
                labelText="Net weight (g)"
                inputMode="decimal"
                autoComplete="off"
                disabled={Boolean(spool)}
                helperText={
                  spool
                    ? 'Corrections change the remaining weight; the initial weight stays.'
                    : (effect ?? 'Filament weight without the spool.')
                }
                invalid={Boolean(errors.weight)}
                invalidText={errors.weight?.message}
                {...register('weight', {
                  validate: (value) => {
                    if (!showFill) return true;
                    const weight = parseDecimal(value);
                    if (weight == null || weight <= 0) return 'Enter a weight above zero.';
                    return !spool && !adding && weight > available
                      ? `Only ${formatGrams(available)} of loose stock is available.`
                      : true;
                  },
                })}
              />
            )}
            {showFill && adding && (
              <>
                <TextInput
                  id="spool-price"
                  labelText="Total price (€)"
                  helperText="Updates the average acquisition cost."
                  inputMode="decimal"
                  autoComplete="off"
                  invalid={Boolean(errors.price)}
                  invalidText={errors.price?.message}
                  {...register('price', {
                    validate: (value) =>
                      !adding || (parseDecimal(value) ?? -1) >= 0 || 'Enter the total price, zero or more.',
                  })}
                />
                <TextInput
                  id="spool-supplier"
                  labelText="Supplier (optional)"
                  autoComplete="off"
                  maxLength={200}
                  {...register('supplier')}
                />
              </>
            )}
            <TextInput
              id="spool-tare"
              labelText="Tare weight in g (optional)"
              helperText="Empty spool, for weighing."
              inputMode="decimal"
              autoComplete="off"
              invalid={Boolean(errors.tare)}
              invalidText={errors.tare?.message}
              {...register('tare', { validate: nonNegative })}
            />
            {showFill && (
              <TextInput
                id="spool-manufacturer"
                labelText="Manufacturer (optional)"
                helperText="Defaults to the manufacturer of the article."
                autoComplete="off"
                maxLength={150}
                {...register('manufacturer')}
              />
            )}
            {showFill && (
              <TextInput
                id="spool-product"
                labelText="Product name (optional)"
                autoComplete="off"
                maxLength={200}
                {...register('product')}
              />
            )}
            {showFill && (
              <DetectedTagPicker
                id="spool-detected-tag"
                open={open}
                spoolId={spool?.id}
                onPick={(tagUid) => setValue('nfcTag', tagUid, { shouldValidate: true, shouldDirty: true })}
              />
            )}
            {showFill && (
              <TextInput
                id="spool-nfc-tag"
                labelText={spool ? 'Add NFC tag (optional)' : 'NFC tag (optional)'}
                helperText={
                  spool
                    ? 'Adds a tag to the current fill. Existing identifiers are listed on the spool page.'
                    : 'As read by the scanner, or pick a tag a printer detects.'
                }
                autoComplete="off"
                maxLength={255}
                invalid={Boolean(errors.nfcTag)}
                invalidText={errors.nfcTag?.message}
                {...register('nfcTag')}
              />
            )}
            <TextInput
              id="spool-location"
              labelText="Storage location (optional)"
              autoComplete="off"
              maxLength={200}
              {...register('location')}
            />
            <Controller
              control={control}
              name="acquiredOn"
              rules={{ required: 'Enter the acquisition date.' }}
              render={({ field, fieldState }) => (
                <DateInput
                  id="spool-acquired"
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
              id="spool-reference"
              labelText="Acquisition reference (optional)"
              helperText="Invoice or order number."
              autoComplete="off"
              maxLength={200}
              {...register('reference')}
            />
            <TextArea id="spool-notes" labelText="Notes (optional)" rows={3} maxLength={2000} {...register('notes')} />
          </Stack>
        </form>
      </FormProvider>
    </Modal>
  );
}
