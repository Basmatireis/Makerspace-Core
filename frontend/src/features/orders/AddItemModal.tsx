import { useState } from 'react';
import { Modal, RadioTile, TileGroup } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { Order } from '../../api/generated/models';
import { customerJobsQuery } from './queries';

export type AddItemKind = 'job' | 'stock' | 'custom';

/**
 * The first step of "Add item": a finished job of this customer, an article from inventory (priced by the customer's
 * group) or a custom line. The chosen kind opens its own dialog.
 */
export function AddItemModal({
  order,
  canJobs,
  canStock,
  onClose,
  onChoose,
}: {
  order: Order;
  canJobs: boolean;
  canStock: boolean;
  onClose: () => void;
  onChoose: (kind: AddItemKind) => void;
}) {
  const jobs = useQuery({ ...customerJobsQuery(order.customer?.id ?? ''), enabled: canJobs && !!order.customer });
  const ready = jobs.data?.length ?? 0;
  const customer = order.customerName ?? 'this customer';
  const [chosen, setChosen] = useState<AddItemKind | null>(null);
  const fallback: AddItemKind = canJobs && ready > 0 ? 'job' : canStock ? 'stock' : 'custom';
  const kind = chosen ?? fallback;
  const options: { value: AddItemKind; title: string; detail: string; shown: boolean }[] = [
    {
      value: 'job',
      title: 'A finished job',
      detail: jobs.isPending ? 'Looking for jobs…' : `${ready} ready for ${customer}`,
      shown: canJobs,
    },
    {
      value: 'stock',
      title: 'Something from inventory',
      detail: 'Filament, sheets, parts; priced by the customer’s pricing group',
      shown: canStock,
    },
    {
      value: 'custom',
      title: 'A custom line',
      detail: 'Workshop fee, deposit, anything without an article',
      shown: true,
    },
  ];
  return (
    <Modal
      open
      size="sm"
      modalHeading="Add to order"
      modalLabel={`${order.reference} · ${order.customerName ?? 'No customer'}`}
      primaryButtonText="Continue"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => onChoose(kind)}
    >
      <TileGroup
        legend="What do you want to add?"
        name="order-add-kind"
        valueSelected={kind}
        onChange={(value) => setChosen(value as AddItemKind)}
        className="sales-choice"
      >
        {options
          .filter((option) => option.shown)
          .map((option) => (
            <RadioTile key={option.value} id={`order-add-${option.value}`} value={option.value}>
              <span className="sales-cell">
                <strong>{option.title}</strong>
                <span className="sales-secondary">{option.detail}</span>
              </span>
            </RadioTile>
          ))}
      </TileGroup>
    </Modal>
  );
}
