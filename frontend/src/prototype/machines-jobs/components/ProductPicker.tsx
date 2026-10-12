import { Checkbox, ComboBox } from '@carbon/react';
import type { FilamentProduct, Material } from '../types';
import { productLabel } from './inventoryShared';

type Props = {
  id: string;
  /** Selectable products (active ones). */
  products: FilamentProduct[];
  materials: Material[];
  productId: string;
  /** True when the filament is not in the catalog and the manual fields are shown instead. */
  manual: boolean;
  onProduct: (product: FilamentProduct | null) => void;
  onManual: (manual: boolean) => void;
  invalid?: boolean;
  invalidText?: string;
};

/** Product ComboBox searchable by manufacturer, name and material, with a "Not in catalog" escape to the manual fields. */
export function ProductPicker({ id, products, materials, productId, manual, onProduct, onManual, invalid, invalidText }: Props) {
  const materialName = (product: FilamentProduct) => materials.find((item) => item.id === product.materialId)?.name ?? '';
  return (
    <>
      <ComboBox<FilamentProduct>
        id={id} titleText="Product" placeholder="Search by manufacturer, product or material" items={products} disabled={manual}
        helperText="Fills in material, net weight and the default price."
        itemToString={(item) => item ? productLabel(item) : ''}
        shouldFilterItem={({ item, inputValue }) => {
          const terms = (inputValue ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
          if (!item || terms.length === 0) return true;
          const haystack = [item.manufacturer, item.name, materialName(item)].join(' ').toLowerCase();
          return terms.every((term) => haystack.includes(term));
        }}
        selectedItem={products.find((item) => item.id === productId) ?? null} onChange={({ selectedItem }) => onProduct(selectedItem ?? null)}
        invalid={invalid} invalidText={invalidText}
      />
      <Checkbox id={`${id}-manual`} labelText="Not in catalog" helperText="Enter material, manufacturer and product by hand." checked={manual} onChange={(_event, { checked }) => onManual(checked)} />
    </>
  );
}
