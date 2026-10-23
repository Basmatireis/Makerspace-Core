/* eslint-disable react-refresh/only-export-components -- the shared article fields and their value helpers belong together */
import { useState } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Button, ComboBox, TextArea, TextInput } from '@carbon/react';
import { useStableItems } from '../../../app/useStableItems';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createMaterialType } from '../../../api/generated/inventory/inventory';
import type {
  CreateMaterialRequest,
  Material,
  MaterialKind,
  MaterialType,
  MaterialUnit,
} from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { ColorFieldRow, ColorPicker } from '../../../app/ColorPicker';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { COLOR_HEX_PATTERN, reportedToMaterialHex } from '../colors';
import { materialTypesQuery, suggestionsQuery } from '../inventoryQueries';
import { machineLogbookKeys } from '../queries';
import { generatedArticleName, toDecimal, toMoney, typeNoun, typeNounLower, unitLabel } from './inventoryShared';

/** The descriptive fields of an article, shared by the Receive stock form and the article form. */
export type ArticleValues = {
  materialTypeId: string;
  variant: string;
  name: string;
  colorName: string;
  colorHex: string;
  manufacturer: string;
  diameter: string;
  packageSize: string;
  salePrice: string;
  location: string;
  threshold: string;
  notes: string;
};
/** Forms that embed the article fields keep them under `article`. */
export type WithArticle = { article: ArticleValues };

export const blankArticle = (kind: MaterialKind, typeId = ''): ArticleValues => ({
  materialTypeId: typeId,
  variant: '',
  name: '',
  colorName: '',
  colorHex: '',
  manufacturer: '',
  diameter: kind === 'filament' ? '1.75' : '',
  packageSize: '',
  salePrice: '',
  location: '',
  threshold: '',
  notes: '',
});

/** Values of an existing article. A name that is just the generated one is left empty so it follows later changes. */
export function articleValuesOf(material: Material): ArticleValues {
  const generated = generatedArticleName({
    typeName: material.materialTypeName,
    variant: material.variant,
    colorName: material.colorName,
    manufacturer: material.manufacturer,
  });
  return {
    materialTypeId: material.materialTypeId,
    variant: material.variant ?? '',
    name: material.kind !== 'part' && material.name === generated ? '' : material.name,
    colorName: material.colorName ?? '',
    colorHex: material.colorHex ?? '',
    manufacturer: material.manufacturer ?? '',
    diameter: material.filamentDiameterMm != null ? decimalText(material.filamentDiameterMm) : '',
    packageSize: material.packageSize != null ? decimalText(material.packageSize) : '',
    salePrice: material.salePrice != null ? decimalText(material.salePrice) : '',
    location: material.storageLocation ?? '',
    threshold: material.lowStockThreshold != null ? decimalText(material.lowStockThreshold) : '',
    notes: material.notes ?? '',
  };
}

const orNull = (value: string) => value.trim() || null;
const optionalDecimal = (value: string) => {
  const parsed = decimalNumber(value);
  return parsed == null ? null : toDecimal(parsed);
};

/** Request body of an article from the form values; the name stays out when it is to be generated. */
export function articleBody(values: ArticleValues, kind: MaterialKind): CreateMaterialRequest {
  const price = decimalNumber(values.salePrice, { places: 2 });
  const colour = kind !== 'part';
  return {
    ...(values.name.trim() ? { name: values.name.trim() } : {}),
    materialTypeId: values.materialTypeId,
    variant: kind === 'part' ? null : orNull(values.variant),
    manufacturer: orNull(values.manufacturer),
    salePrice: price == null ? null : toMoney(price),
    packageSize: optionalDecimal(values.packageSize),
    storageLocation: orNull(values.location),
    notes: orNull(values.notes),
    colorName: colour ? orNull(values.colorName) : null,
    colorHex: colour ? orNull(values.colorHex.toUpperCase()) : null,
    lowStockThreshold: optionalDecimal(values.threshold),
    filamentDiameterMm: kind === 'filament' ? optionalDecimal(values.diameter) : null,
  };
}

/** The name an article with these values gets: the typed one, or the generated one. */
export const previewName = (values: ArticleValues, kind: MaterialKind, typeName: string | undefined) =>
  values.name.trim() ||
  (kind === 'part'
    ? ''
    : generatedArticleName({
        typeName,
        variant: values.variant,
        colorName: values.colorName,
        manufacturer: values.manufacturer,
      }));

/** Defaults of a type created from an article form; staff refine it under Types & categories. */
const newTypeDefaults = (
  kind: MaterialKind,
  name: string,
): { name: string; kind: MaterialKind; unit: MaterialUnit; processes?: 'other'[] } =>
  kind === 'filament'
    ? { name, kind, unit: 'g' }
    : kind === 'consumable'
      ? { name, kind, unit: 'piece', processes: ['other'] }
      : { name, kind, unit: 'piece' };

/** A text field with suggestions that still takes any typed value. */
export function SuggestionComboBox({
  id,
  titleText,
  items,
  value,
  onChange,
  helperText,
  invalid,
  invalidText,
  placeholder,
}: {
  id: string;
  titleText: string;
  items: string[];
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  invalid?: boolean;
  invalidText?: string;
  placeholder?: string;
}) {
  return (
    <ComboBox<string>
      autoAlign
      id={id}
      titleText={titleText}
      items={items}
      allowCustomValue
      initialSelectedItem={value || undefined}
      placeholder={placeholder}
      helperText={helperText}
      invalid={invalid}
      invalidText={invalidText}
      shouldFilterItem={({ item, inputValue }) =>
        !inputValue || String(item).toLowerCase().includes(inputValue.toLowerCase())
      }
      onInputChange={(text) => onChange(text ?? '')}
      onChange={({ selectedItem }) => onChange(selectedItem ?? '')}
    />
  );
}

type TypeItem = { id: string; label: string; create?: boolean };

type Props = {
  kind: MaterialKind;
  /** Prefix of element IDs, unique per dialog. */
  idPrefix: string;
  /** The unit shown next to the package size; the type's unit once a type is chosen. */
  unit?: MaterialUnit;
  /** An inactive type that must stay selectable (the article's current one). */
  keepTypeId?: string;
  /** A printer or file reported this colour (RRGGBB); offers a one-click "Use reported color". */
  reportedColorHex?: string | null;
  showNotes?: boolean;
  /** Stock and unit of an existing article block a unit-changing type. */
  hasStock?: boolean;
};

/**
 * Fields that describe an article. Render inside a FormProvider whose values include `article` (see WithArticle).
 * The material type (category for parts) is a combo box that can create a missing type on the spot.
 */
export function ArticleFields({
  kind,
  idPrefix,
  unit,
  keepTypeId,
  reportedColorHex,
  showNotes = false,
  hasStock = false,
}: Props) {
  const {
    control,
    register,
    setValue,
    formState: { errors },
  } = useFormContext<WithArticle>();
  const client = useQueryClient();
  const types = useQuery(materialTypesQuery());
  const [created, setCreated] = useState<MaterialType[]>([]);
  const [typeText, setTypeText] = useState('');
  const [typeError, setTypeError] = useState<string | null>(null);
  const values = useWatch({ control, name: 'article' });
  const noun = typeNoun(kind);
  const choices = [
    ...(types.data ?? []),
    ...created.filter((item) => !(types.data ?? []).some((known) => known.id === item.id)),
  ].filter((item) => item.kind === kind && (item.active || item.id === keepTypeId));
  const chosenType = choices.find((item) => item.id === values.materialTypeId);
  const suggestions = useQuery(suggestionsQuery(values.materialTypeId || undefined)).data;
  const activeUnit = chosenType?.unit ?? unit;
  const previewHex = COLOR_HEX_PATTERN.test(values.colorHex.trim().toUpperCase())
    ? values.colorHex.trim().toUpperCase()
    : null;
  const generated =
    kind !== 'part'
      ? generatedArticleName({
          typeName: chosenType?.name,
          variant: values.variant,
          colorName: values.colorName,
          manufacturer: values.manufacturer,
        })
      : '';

  const createType = useMutation({
    mutationFn: (name: string) => createMaterialType(newTypeDefaults(kind, name)),
    onSuccess: async (type) => {
      setCreated((current) => [...current, type]);
      setTypeError(null);
      setValue('article.materialTypeId', type.id, { shouldValidate: true, shouldDirty: true });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: (error) =>
      setTypeError(
        error instanceof ApiError && error.status === 409
          ? `A ${typeNounLower(kind)} with this name already exists.`
          : `The ${typeNounLower(kind)} could not be created.`,
      ),
  });

  const trimmed = typeText.trim();
  const exists = choices.some((item) => item.name.toLowerCase() === trimmed.toLowerCase());
  const choiceItems = useStableItems<TypeItem>(
    choices.map((item) => ({
      id: item.id,
      label: kind === 'part' ? item.name : `${item.name} (${unitLabel(item.unit)})`,
    })),
  );
  const items: TypeItem[] =
    trimmed && !exists
      ? [...choiceItems, { id: '__create__', label: `Create ${typeNounLower(kind)} "${trimmed}"`, create: true }]
      : choiceItems;
  const selected = choiceItems.find((item) => item.id === values.materialTypeId) ?? null;

  return (
    <>
      <Controller
        control={control}
        name="article.materialTypeId"
        rules={{ validate: (value) => (value ? true : `Choose a ${typeNounLower(kind)}.`) }}
        render={({ field, fieldState }) => (
          <ComboBox<TypeItem>
            autoAlign
            id={`${idPrefix}-type`}
            titleText={noun === 'Category' ? 'Category' : 'Material type'}
            items={items}
            itemToString={(item) => item?.label ?? ''}
            placeholder={kind === 'part' ? 'Choose or create a category' : 'Choose or create a material type'}
            helperText={
              types.isError
                ? 'The types could not be loaded.'
                : kind === 'part'
                  ? 'Type a new name to create the category.'
                  : 'Prices are set per material type. Type a new name to create it.'
            }
            selectedItem={selected}
            disabled={createType.isPending}
            shouldFilterItem={({ item, inputValue }) =>
              Boolean(item?.create) ||
              !inputValue ||
              inputValue === selected?.label ||
              (item?.label ?? '').toLowerCase().includes(inputValue.toLowerCase())
            }
            onInputChange={(text) => setTypeText(text ?? '')}
            onChange={({ selectedItem }) => {
              if (selectedItem?.create) {
                createType.mutate(trimmed);
                return;
              }
              setTypeError(null);
              field.onChange(selectedItem?.id ?? '');
            }}
            invalid={fieldState.invalid || Boolean(typeError)}
            invalidText={typeError ?? fieldState.error?.message}
          />
        )}
      />
      {kind !== 'part' && (
        <Controller
          control={control}
          name="article.variant"
          render={({ field }) => (
            <SuggestionComboBox
              key={`${idPrefix}-variant-${values.materialTypeId}`}
              id={`${idPrefix}-variant`}
              titleText="Variant (optional)"
              items={suggestions?.variants ?? []}
              value={field.value}
              onChange={field.onChange}
              helperText={
                kind === 'filament' ? 'For example Basic, Matte, Silk, High Flow, CF.' : 'For example 3 mm or matte.'
              }
            />
          )}
        />
      )}
      <TextInput
        id={`${idPrefix}-name`}
        labelText={kind === 'part' ? 'Name' : 'Name (optional)'}
        autoComplete="off"
        maxLength={150}
        placeholder={kind === 'part' ? 'For example M3 heat-set insert' : generated || undefined}
        helperText={
          kind === 'part'
            ? undefined
            : generated
              ? `Leave empty to name it "${generated}".`
              : 'Leave empty to generate the name from type, variant, colour and manufacturer.'
        }
        invalid={Boolean(errors.article?.name)}
        invalidText={errors.article?.name?.message}
        {...register('article.name', {
          validate: (value) => (kind !== 'part' || value.trim() ? true : 'Enter a name.'),
        })}
      />
      {kind !== 'part' && (
        <>
          <TextInput
            id={`${idPrefix}-color-name`}
            labelText="Colour name (optional)"
            helperText="For example Signal red."
            autoComplete="off"
            invalid={Boolean(errors.article?.colorName)}
            invalidText={errors.article?.colorName?.message}
            {...register('article.colorName', { maxLength: { value: 80, message: 'Use at most 80 characters.' } })}
          />
          <ColorFieldRow>
            <TextInput
              id={`${idPrefix}-color-hex`}
              labelText="Colour code (optional)"
              helperText="#RRGGBB, for example #C62828."
              autoComplete="off"
              placeholder="#C62828"
              invalid={Boolean(errors.article?.colorHex)}
              invalidText={errors.article?.colorHex?.message}
              {...register('article.colorHex', {
                validate: (value) =>
                  !value.trim() ||
                  COLOR_HEX_PATTERN.test(value.trim().toUpperCase()) ||
                  'Use the form #RRGGBB, for example #C62828.',
                setValueAs: (value: string) => value.toUpperCase(),
              })}
            />
            <ColorPicker
              label="Colour code"
              value={previewHex}
              onChange={(next) =>
                setValue('article.colorHex', next.toUpperCase(), { shouldDirty: true, shouldValidate: true })
              }
            />
          </ColorFieldRow>
          {reportedColorHex && previewHex !== reportedToMaterialHex(reportedColorHex) && (
            <Button
              kind="tertiary"
              size="sm"
              onClick={() =>
                setValue('article.colorHex', reportedToMaterialHex(reportedColorHex), {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
            >
              Use reported color ({reportedToMaterialHex(reportedColorHex)})
            </Button>
          )}
        </>
      )}
      <Controller
        control={control}
        name="article.manufacturer"
        render={({ field }) => (
          <SuggestionComboBox
            id={`${idPrefix}-manufacturer`}
            titleText="Manufacturer (optional)"
            items={suggestions?.manufacturers ?? []}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      {kind === 'filament' && (
        <Controller
          control={control}
          name="article.diameter"
          rules={{ validate: decimalValidator({ positive: true, requiredMessage: 'Enter the filament diameter.' }) }}
          render={({ field, fieldState }) => (
            <DecimalField
              id={`${idPrefix}-diameter`}
              labelText="Filament diameter in mm"
              helperText="For example 1.75."
              value={field.value}
              onChange={field.onChange}
              invalid={fieldState.invalid}
              invalidText={fieldState.error?.message}
            />
          )}
        />
      )}
      <Controller
        control={control}
        name="article.packageSize"
        rules={{ validate: decimalValidator({ positive: true, optional: true }) }}
        render={({ field, fieldState }) => (
          <DecimalField
            id={`${idPrefix}-package-size`}
            labelText={`Package size${activeUnit ? ` in ${unitLabel(activeUnit)}` : ''} (optional)`}
            helperText={
              kind === 'filament'
                ? 'For example 1000 for a 1 kg roll. Prefills Receive stock.'
                : 'For example 100 for a bag of 100. Prefills Receive stock.'
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
        name="article.salePrice"
        rules={{ validate: decimalValidator({ places: 2, optional: true }) }}
        render={({ field, fieldState }) => (
          <DecimalField
            id={`${idPrefix}-sale-price`}
            labelText={`Sale price per ${activeUnit ? unitLabel(activeUnit) : 'unit'} in EUR (optional)`}
            helperText="Default unit price when the article is sold in an order."
            value={field.value}
            onChange={field.onChange}
            invalid={fieldState.invalid}
            invalidText={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="article.location"
        render={({ field }) => (
          <SuggestionComboBox
            id={`${idPrefix}-location`}
            titleText="Storage location (optional)"
            items={suggestions?.storageLocations ?? []}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <Controller
        control={control}
        name="article.threshold"
        rules={{ validate: decimalValidator({ optional: true }) }}
        render={({ field, fieldState }) => (
          <DecimalField
            id={`${idPrefix}-threshold`}
            labelText={`Low-stock threshold${activeUnit ? ` in ${unitLabel(activeUnit)}` : ''} (optional)`}
            helperText="Stock at or below this quantity is flagged as low."
            value={field.value}
            onChange={field.onChange}
            invalid={fieldState.invalid}
            invalidText={fieldState.error?.message}
          />
        )}
      />
      {showNotes && (
        <TextArea
          id={`${idPrefix}-notes`}
          labelText="Notes (optional)"
          rows={3}
          maxLength={2000}
          {...register('article.notes')}
        />
      )}
      {hasStock && (
        <p className="mj-secondary">The unit follows the {typeNounLower(kind)} and cannot change while stock exists.</p>
      )}
    </>
  );
}
