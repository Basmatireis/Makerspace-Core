import { Select, SelectItem, TextInput } from '@carbon/react';
import type { UseFormReturn } from 'react-hook-form';
import type { MaterialFields } from './materialForm';

export function InventoryMaterialFields({ form, existing = false }: { form: UseFormReturn<MaterialFields>; existing?: boolean }) {
  return <>
    <TextInput id="material-name" labelText="Name" invalid={Boolean(form.formState.errors.name)} invalidText="Enter a material name." {...form.register('name', { required: true, validate: (value) => Boolean(value.trim()) })} />
    <TextInput id="material-category" labelText="Category" helperText="For example: pla, petg, plywood" invalid={Boolean(form.formState.errors.category)} invalidText="Enter a category." {...form.register('category', { required: true, validate: (value) => Boolean(value.trim()) })} />
    <TextInput id="material-color" labelText="Color (optional)" {...form.register('color')} />
    <Select id="material-unit" labelText="Unit" helperText={existing ? 'The unit cannot change while stock or filament spools exist.' : undefined} {...form.register('unit')}>
      <SelectItem value="g" text="Grams (g)" /><SelectItem value="m" text="Metres (m)" /><SelectItem value="ml" text="Millilitres (ml)" /><SelectItem value="m2" text="Square metres (m²)" /><SelectItem value="piece" text="Pieces" />
    </Select>
    <TextInput id="material-low-stock" labelText="Low-stock threshold (optional)" {...form.register('lowStockThreshold')} />
    <TextInput id="material-filament-diameter" labelText="Filament diameter (mm, optional)" helperText="For gram-denominated filament, for example 1.75." {...form.register('filamentDiameterMm')} />
  </>;
}
