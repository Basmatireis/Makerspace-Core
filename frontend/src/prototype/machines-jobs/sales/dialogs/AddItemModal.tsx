import { useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useStore } from '../../store';
import { formatEur, parseMoney, parseQuantity, round2 } from '../format';
import type { OrderView } from '../logic';
import { catalogItems } from '../pricing';
import { ProposedTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { CatalogItem } from '../types';

/** A free-text item (exists today) or a catalog item ([proposed]: the sale catalog). */
export function AddItemModal({ order, kind, onClose }: { order: OrderView; kind: 'custom' | 'catalog'; onClose: () => void }) {
  const store = useStore();
  const [catalogItem, setCatalogItem] = useState<CatalogItem | null>(null);
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('piece');
  const [unitPrice, setUnitPrice] = useState('');
  const parsedQuantity = parseQuantity(quantity);
  const price = kind === 'catalog' ? catalogItem?.unitPrice ?? null : parseMoney(unitPrice);
  const text = kind === 'catalog' ? catalogItem?.name ?? '' : description;
  const valid = text.trim() !== '' && parsedQuantity !== null && parsedQuantity > 0 && price !== null;
  const { mutate, pending, error } = useSalesMutation(() => store.addOrderManualItem(order.id, {
    description: text, quantity: parsedQuantity!, unit: kind === 'catalog' ? catalogItem!.unit : unit, unitPrice: price!, catalogItemId: catalogItem?.id ?? null,
  }));

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: 'Item added', subtitle: `${text} · ${formatEur(round2((parsedQuantity ?? 0) * (price ?? 0)))}` });
    onClose();
  };

  return (
    <Modal
      open size="sm" modalHeading={kind === 'catalog' ? 'Add catalog item' : 'Add custom item'} modalLabel={order.reference} primaryButtonText={pending ? 'Adding…' : 'Add item'} secondaryButtonText="Cancel"
      primaryButtonDisabled={!valid || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        {kind === 'catalog' ? (
          <>
            <div className="mj-inline"><ProposedTag hint="Needs a sale catalog with fixed prices" /><span className="mj-secondary">Fixed-price items for filament, small parts and spare parts</span></div>
            <ComboBox autoAlign id="catalog-item" titleText="Catalog item" placeholder="Search the catalog" items={catalogItems} itemToString={(item) => item ? `${item.name} · ${formatEur(item.unitPrice)} per ${item.unit}` : ''}
              selectedItem={catalogItem} onChange={({ selectedItem }) => setCatalogItem(selectedItem ?? null)} />
          </>
        ) : (
          <>
            <TextInput id="custom-description" labelText="Description" value={description} onChange={(event) => setDescription(event.target.value)} helperText="Shown on the order and the receipt." />
            <div className="mj-form-grid">
              <TextInput id="custom-unit" labelText="Unit" value={unit} onChange={(event) => setUnit(event.target.value)} helperText="e.g. piece, hour, gram" />
              <TextInput id="custom-price" labelText="Unit price (€)" inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} invalid={unitPrice !== '' && price === null} invalidText="Use an amount like 4,50" />
            </div>
          </>
        )}
        <TextInput id="item-quantity" labelText={`Quantity${kind === 'catalog' && catalogItem ? ` (${catalogItem.unit})` : ''}`} inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)}
          invalid={parsedQuantity === null || parsedQuantity <= 0} invalidText="Enter a quantity greater than zero, up to three decimals" />
        {valid && <p>Line total: <strong>{formatEur(round2(parsedQuantity! * price!))}</strong></p>}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not add" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
