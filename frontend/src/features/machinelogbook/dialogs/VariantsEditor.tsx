import { useState } from 'react';
import { Button, IconButton, InlineNotification, Stack, TextInput } from '@carbon/react';
import { Add, Checkmark, TrashCan } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createMaterialTypeVariant,
  deleteMaterialTypeVariant,
  updateMaterialTypeVariant,
} from '../../../api/generated/inventory/inventory';
import type { MaterialType, MaterialTypeVariant } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

const usageText = (variant: MaterialTypeVariant) => {
  const parts = [
    variant.materialCount > 0 ? `${variant.materialCount} ${variant.materialCount === 1 ? 'article' : 'articles'}` : '',
    variant.pricingRuleCount > 0
      ? `${variant.pricingRuleCount} ${variant.pricingRuleCount === 1 ? 'price rule' : 'price rules'}`
      : '',
  ].filter(Boolean);
  return parts.length ? `Used by ${parts.join(' and ')}.` : 'Not used yet.';
};

const errorText = (error: unknown, fallback: string) => {
  if (error instanceof ApiError && error.data?.code === 'material_type_variant_exists')
    return 'This type already has a variant with this name.';
  if (error instanceof ApiError && error.data?.code === 'material_type_variant_in_use')
    return 'The variant is used by articles or price rules.';
  return error instanceof ApiError ? error.message : fallback;
};

function VariantRow({ type, variant }: { type: MaterialType; variant: MaterialTypeVariant }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [name, setName] = useState(variant.name);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const rename = useMutation({
    mutationFn: () => updateMaterialTypeVariant(type.id, variant.id, { name: name.trim() }),
    onSuccess: async (saved) => {
      setError(null);
      await refresh();
      notify({ kind: 'success', title: 'Variant renamed', subtitle: saved.name });
    },
    onError: (failure) => setError(errorText(failure, 'The variant could not be renamed.')),
  });
  const remove = useMutation({
    mutationFn: () => deleteMaterialTypeVariant(type.id, variant.id),
    onSuccess: async () => {
      await refresh();
      notify({ kind: 'success', title: 'Variant deleted', subtitle: variant.name });
    },
    onError: (failure) => setError(errorText(failure, 'The variant could not be deleted.')),
  });
  const inUse = variant.materialCount > 0 || variant.pricingRuleCount > 0;
  const changed = name.trim() !== variant.name && name.trim() !== '';
  const busy = rename.isPending || remove.isPending;
  return (
    <div className="inv-variant-row">
      <TextInput
        id={`variant-${variant.id}`}
        size="sm"
        labelText={`Name of variant ${variant.name}`}
        hideLabel
        autoComplete="off"
        maxLength={80}
        value={name}
        helperText={usageText(variant)}
        invalid={Boolean(error)}
        invalidText={error ?? undefined}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (changed && !busy) rename.mutate();
          }
        }}
      />
      <IconButton
        kind="ghost"
        size="sm"
        label={`Save name of ${variant.name}`}
        disabled={!changed || busy}
        onClick={() => rename.mutate()}
      >
        <Checkmark />
      </IconButton>
      <IconButton
        kind="ghost"
        size="sm"
        label={inUse ? `${variant.name} is in use and cannot be deleted` : `Delete ${variant.name}`}
        disabled={inUse || busy}
        onClick={() => remove.mutate()}
      >
        <TrashCan />
      </IconButton>
    </div>
  );
}

/**
 * The fixed list of variants of a filament or consumable type. Every change is saved at once, independent of the
 * type's own Save button; a variant that articles or price rules use can be renamed but not deleted.
 */
export function VariantsEditor({ type }: { type: MaterialType }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => createMaterialTypeVariant(type.id, { name: name.trim() }),
    onSuccess: async (saved) => {
      setName('');
      setError(null);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Variant added', subtitle: saved.name });
    },
    onError: (failure) => setError(errorText(failure, 'The variant could not be added.')),
  });
  const submit = () => {
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    add.mutate();
  };
  return (
    <fieldset className="inv-variants">
      <legend className="cds--label">Variants</legend>
      <Stack gap={3}>
        <p className="mj-secondary">
          Articles of this type pick their variant from this list. Changes here are saved immediately; the Save button
          only saves the type itself.
        </p>
        {type.variants.length === 0 && <p className="mj-secondary">No variants yet.</p>}
        {type.variants.map((variant) => (
          <VariantRow key={`${variant.id}-${variant.name}`} type={type} variant={variant} />
        ))}
        <div className="inv-variant-row">
          <TextInput
            id="material-type-new-variant"
            size="sm"
            labelText="New variant"
            hideLabel
            placeholder="New variant"
            helperText="For example Matte"
            autoComplete="off"
            maxLength={80}
            value={name}
            invalid={Boolean(error) && !add.isPending}
            invalidText={error ?? undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button kind="tertiary" size="sm" renderIcon={Add} disabled={add.isPending} onClick={submit}>
            Add variant
          </Button>
        </div>
        {add.isError && !error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="The variant was not added" />
        )}
      </Stack>
    </fieldset>
  );
}
