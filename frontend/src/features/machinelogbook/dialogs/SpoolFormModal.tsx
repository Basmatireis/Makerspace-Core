import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
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
import { createFilamentSpool, updateFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, FilamentSpoolKind } from '../../../api/generated/models';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { formatGrams, parseDecimal, toDecimal } from '../components/inventoryShared';
import { hasOpenFill, toNumber } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import { filamentMaterialsQuery, spoolErrorMessage, spoolUpdateBody, useRefreshInventory } from '../spoolData';

type Values = {
  kind: FilamentSpoolKind;
  label: string;
  materialId: string;
  weight: string;
  tare: string;
  manufacturer: string;
  product: string;
  location: string;
  firstFill: 'fill' | 'empty';
  acquiredOn: string;
  reference: string;
  notes: string;
};

const nonNegative = (value: string) =>
  !value.trim() || (parseDecimal(value) ?? -1) >= 0 || 'Enter a number of zero or more.';
const orNull = (value: string) => value.trim() || null;

/**
 * Registers a physical spool that already exists: it takes its filament from loose stock, or stays empty for a
 * reusable spool. Purchases are booked with Receive stock. With a spool, edits its descriptive fields.
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
  const refresh = useRefreshInventory();
  const materials = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const keptMaterialId = spool?.materialId ?? initialMaterialId;
  const choices = (materials.data ?? []).filter((material) => material.active || material.id === keptMaterialId);
  const defaults = (): Values => ({
    kind: spool?.kind ?? 'reusable',
    label: spool?.label ?? '',
    materialId: spool?.materialId ?? initialMaterialId ?? '',
    weight: spool ? String(toNumber(spool.initialNetWeightG)) : '1000',
    tare: spool?.tareWeightG != null ? String(toNumber(spool.tareWeightG)) : '',
    manufacturer: spool?.manufacturer ?? '',
    product: spool?.productName ?? '',
    location: spool?.storageLocation ?? '',
    firstFill: 'fill',
    acquiredOn: spool?.acquiredOn ?? dateInAppTimeZone(new Date()),
    reference: spool?.acquisitionReference ?? '',
    notes: spool?.notes ?? '',
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({ defaultValues: defaults() });
  // Reusable spools can be registered empty; an existing spool without a current fill has nothing to edit about a fill.
  const showFill = spool ? hasOpenFill(spool) : watch('kind') === 'single_use' || watch('firstFill') === 'fill';
  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const tare = parseDecimal(values.tare);
      if (spool) {
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
      });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    mutation.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, spool?.id, initialMaterialId, resetForm]);
  const pending = mutation.isPending;
  const selectedMaterial = choices.find((material) => material.id === watch('materialId'));
  const available = selectedMaterial ? toNumber(selectedMaterial.unassignedQuantity) : 0;
  const typedWeight = parseDecimal(watch('weight')) ?? 0;
  const effect = selectedMaterial
    ? `Moves ${formatGrams(typedWeight)} from loose stock to this spool. The total stays ${formatGrams(toNumber(selectedMaterial.quantity))}; ${formatGrams(available)} is loose.`
    : undefined;

  const submit = handleSubmit(async (values) => {
    let saved: FilamentSpool;
    try {
      saved = await mutation.mutateAsync(values);
    } catch {
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
              Registers a spool you already have, using filament from loose stock. To book a purchase, use Receive
              stock.
            </p>
          )}
          {mutation.isError && (
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
          {materials.isSuccess && choices.length === 0 && !spool && (
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
          {showFill && (
            <Select
              id="spool-material"
              labelText="Filament"
              disabled={Boolean(spool)}
              helperText={spool ? 'The article of a registered spool cannot change.' : undefined}
              invalid={Boolean(errors.materialId)}
              invalidText={errors.materialId?.message}
              {...register('materialId', { validate: (value) => !showFill || Boolean(value) || 'Choose a filament.' })}
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
                  return !spool && weight > available
                    ? `Only ${formatGrams(available)} of loose stock is available.`
                    : true;
                },
              })}
            />
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
    </Modal>
  );
}
