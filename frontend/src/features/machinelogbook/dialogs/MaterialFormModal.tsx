import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button, InlineNotification, Modal, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createMaterial, updateMaterial } from '../../../api/generated/inventory/inventory';
import type { Material } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { parseDecimal, toDecimal, unitLabel } from '../components/inventoryShared';
import { COLOR_HEX_PATTERN, reportedToMaterialHex } from '../colors';
import { materialTypesQuery } from '../inventoryQueries';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

type Values = { name: string; materialTypeId: string; colorName: string; colorHex: string; diameter: string; threshold: string; active: boolean };

const optionalNumber = (value: string) => !value.trim() || (parseDecimal(value) != null && (parseDecimal(value) ?? 0) >= 0) || 'Enter a number of zero or more.';
const optionalDecimal = (value: string) => { const parsed = parseDecimal(value); return parsed == null ? null : toDecimal(parsed); };

const validHex = (value: string) => !value.trim() || COLOR_HEX_PATTERN.test(value.trim().toUpperCase()) || 'Use the form #RRGGBB, for example #C62828.';

/**
 * Creates or edits a material. The colour is only captured here. `reportedColorHex` is the colour a printer or a
 * file reported for the context the dialog was opened from (RRGGBB); it offers a one-click "Use reported color".
 */
export function MaterialFormModal({ open, onClose, material, reportedColorHex }: { open: boolean; onClose: () => void; material?: Material; reportedColorHex?: string | null }) {
  const client = useQueryClient();
  const notify = useNotify();
  const hasStock = Boolean(material && Number(material.quantity) > 0);
  const types = useQuery({ ...materialTypesQuery(), enabled: open });
  const defaults = (): Values => ({
    name: material?.name ?? '', materialTypeId: material?.materialTypeId ?? '', colorName: material?.colorName ?? '', colorHex: material?.colorHex ?? '',
    diameter: material?.filamentDiameterMm != null ? String(Number(material.filamentDiameterMm)) : '', threshold: material?.lowStockThreshold != null ? String(Number(material.lowStockThreshold)) : '',
    active: material?.active ?? true,
  });
  const { control, register, handleSubmit, reset, watch, setValue, setError, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  const typeId = watch('materialTypeId');
  const colorHex = watch('colorHex');
  const choices = (types.data ?? []).filter((item) => item.active || item.id === material?.materialTypeId);
  const chosenType = (types.data ?? []).find((item) => item.id === typeId);
  const unit = chosenType?.unit ?? material?.unit;
  const previewHex = COLOR_HEX_PATTERN.test(colorHex.trim().toUpperCase()) ? colorHex.trim().toUpperCase() : null;

  const save = useMutation({
    mutationFn: (values: Values) => {
      const input = {
        name: values.name.trim(), materialTypeId: values.materialTypeId, colorName: values.colorName.trim() || null, colorHex: values.colorHex.trim().toUpperCase() || null,
        lowStockThreshold: optionalDecimal(values.threshold), filamentDiameterMm: optionalDecimal(values.diameter),
      };
      return material ? updateMaterial(material.id, { ...input, active: values.active, expectedVersion: material.version }) : createMaterial(input);
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: material ? 'Material saved' : 'Material added', subtitle: saved.name });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'already_exists') setError('name', { message: 'A material with this name already exists.' });
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { reset(defaults()); save.reset(); } }, [open, material?.id, types.isSuccess]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => { save.mutate(values); });
  const failure = save.error instanceof ApiError && save.error.data?.code === 'already_exists' ? null : save.error;

  return (
    <Modal
      open={open} size="sm" modalHeading={material ? 'Edit material' : 'Add material'}
      primaryButtonText={pending ? 'Saving…' : material ? 'Save material' : 'Add material'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <TextInput
            id="material-name" labelText="Name" autoComplete="off" invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { validate: (value) => value.trim() ? true : 'Enter a material name.' })}
          />
          <Select
            id="material-type" labelText="Material type" invalid={Boolean(errors.materialTypeId)} invalidText={errors.materialTypeId?.message}
            helperText={types.isError ? 'The material types could not be loaded.' : 'Prices are set per material type.'}
            {...register('materialTypeId', { validate: (value) => value ? true : 'Choose a material type.' })}
          >
            <SelectItem value="" text="Select a material type" />
            {choices.map((item) => <SelectItem key={item.id} value={item.id} text={`${item.name} (${unitLabel(item.unit)})`} />)}
          </Select>
          <TextInput
            id="material-unit" labelText="Unit" readOnly value={unit ? unitLabel(unit) : '—'} onChange={() => undefined}
            helperText={hasStock ? 'The unit follows the material type and cannot change while stock or spools exist.' : 'The unit follows the material type.'}
          />
          <TextInput id="material-color-name" labelText="Colour name (optional)" helperText="For example Signal red." autoComplete="off" {...register('colorName', { maxLength: { value: 80, message: 'Use at most 80 characters.' } })} invalid={Boolean(errors.colorName)} invalidText={errors.colorName?.message} />
          <div className="mj-color-field">
            <TextInput
              id="material-color-hex" labelText="Colour code (optional)" helperText="#RRGGBB, for example #C62828." autoComplete="off" placeholder="#C62828"
              invalid={Boolean(errors.colorHex)} invalidText={errors.colorHex?.message}
              {...register('colorHex', { validate: validHex, setValueAs: (value: string) => value.toUpperCase() })}
            />
            <span className="mj-swatch mj-color-field__swatch" style={{ backgroundColor: previewHex ?? 'transparent' }} role="img" aria-label={previewHex ? `Colour ${previewHex}` : 'No colour code'} />
          </div>
          {reportedColorHex && previewHex !== reportedToMaterialHex(reportedColorHex) && (
            <Button kind="tertiary" size="sm" onClick={() => setValue('colorHex', reportedToMaterialHex(reportedColorHex), { shouldDirty: true, shouldValidate: true })}>
              Use reported color ({reportedToMaterialHex(reportedColorHex)})
            </Button>
          )}
          <TextInput
            id="material-diameter" labelText="Filament diameter in mm (optional)" helperText="For example 1.75." inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.diameter)} invalidText={errors.diameter?.message} {...register('diameter', { validate: optionalNumber })}
          />
          <TextInput
            id="material-threshold" labelText={`Low-stock threshold${unit ? ` in ${unitLabel(unit)}` : ''} (optional)`} helperText="Stock at or below this quantity is flagged as low." inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.threshold)} invalidText={errors.threshold?.message} {...register('threshold', { validate: optionalNumber })}
          />
          {material && (
            <Controller
              control={control} name="active"
              render={({ field }) => (
                <Toggle id="material-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={(checked) => field.onChange(checked)} />
              )}
            />
          )}
          {failure && <InlineNotification kind="error" lowContrast hideCloseButton title="The material was not saved" subtitle={failure instanceof ApiError ? failure.message : 'Try again.'} />}
        </Stack>
      </form>
    </Modal>
  );
}
