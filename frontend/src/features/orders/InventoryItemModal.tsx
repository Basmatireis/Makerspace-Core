import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { InlineNotification, Link as CarbonLink, Modal, Stack, Tag, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { addOrderItem, updateOrderItem } from '../../api/generated/orders/orders';
import type { Material, MaterialPrice, Order, OrderItem } from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { RichNotification } from '../../app/RichNotification';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { allMaterialsQuery } from '../machinelogbook/inventoryQueries';
import { billingPartySearchQuery } from '../machinelogbook/queries';
import { formatQuantity } from '../machinelogbook/shared/format';
import { formatMoney } from './formatting';
import { articlePriceMissing } from './logic';
import { formatCents, lineAmountCents, parseDecimalInput } from './money';
import { useFinanceMutation } from './queries';
import { articleUnitLabel, unitDisplay } from '../machinelogbook/units';

type StockValues = { quantity: string; unitPrice: string };

const articleLabel = (article: Material | null) => (article ? `${article.displayId} · ${article.name}` : '');
const priceText = (price: MaterialPrice, unit: string) =>
  `${price.pricingGroupName} ${formatMoney(price.rate)} / ${unit}${price.source === 'material_type' ? ' (type rate)' : ''}`;

/**
 * The pricing group of an organization customer when the organization has one of its own. People are priced by their
 * roles, which only the server resolves: for them the price is left to the server.
 */
function useOrganizationGroup(order: Order, enabled: boolean) {
  const organization = order.customer?.kind === 'organization' ? order.customer : null;
  const parties = useQuery({
    ...billingPartySearchQuery(order.customerName ?? ''),
    enabled: enabled && !!organization && !!order.customerName,
  });
  return parties.data?.items.find((party) => party.id === organization?.id)?.pricingGroup ?? null;
}

/**
 * Sells an inventory article from stock: adds an inventory item to a draft, or edits quantity and price of one. A new
 * item takes the article's price in the customer's pricing group unless a unit price is entered.
 */
export function InventoryItemModal({
  order,
  item,
  onClose,
}: {
  order: Order;
  item: OrderItem | null;
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const editing = item !== null;
  const [article, setArticle] = useState<Material | null>(null);
  const form = useForm<StockValues>({
    defaultValues: item ? { quantity: item.quantity, unitPrice: item.unitPrice } : { quantity: '1', unitPrice: '' },
  });
  const articles = useQuery({ ...allMaterialsQuery(), enabled: !editing });
  const group = useOrganizationGroup(order, !editing);
  const choices = (articles.data?.items ?? []).filter((candidate) => candidate.active);
  const mutation = useFinanceMutation(async (values: StockValues) => {
    const price = values.unitPrice.trim() ? parseDecimalInput(values.unitPrice)! : undefined;
    const input = {
      kind: 'inventory_item' as const,
      materialId: (item ? item.sourceMaterialId : article?.id) ?? undefined,
      quantity: parseDecimalInput(values.quantity)!,
      unitPrice: price,
      expectedVersion: order.version,
    };
    return item ? updateOrderItem(order.id, item.id, input) : addOrderItem(order.id, input);
  }, onClose);

  const errors = form.formState.errors;
  const [quantityText, unitPriceText] = form.watch(['quantity', 'unitPrice']);
  const quantity = parseDecimalInput(quantityText);
  const price = parseDecimalInput(unitPriceText);
  const unit = item ? unitDisplay(item.unit) : article ? articleUnitLabel(article.unit, article.countLabel) : '';
  const amount = quantity !== null && price !== null ? lineAmountCents(quantity, price) : null;
  const short = !editing && article && quantity !== null && Number(quantity) > Number(article.unassignedQuantity);
  const groupPrice = group && article?.prices.find((entry) => entry.pricingGroupId === group.id);
  const missing = articlePriceMissing(mutation.error);
  const selectArticle = (selected: Material | null) => {
    setArticle(selected);
    mutation.reset();
    const preset = group && selected?.prices.find((entry) => entry.pricingGroupId === group.id);
    form.setValue('unitPrice', preset ? preset.rate : '', { shouldValidate: form.formState.isSubmitted });
  };
  const priceHelper = editing
    ? undefined
    : !article
      ? 'Pick an article first.'
      : groupPrice
        ? `The ${group?.name} price of ${order.customerName ?? 'this customer'}.`
        : article.prices.length > 0
          ? 'Leave empty to charge the price of the customer’s pricing group.'
          : 'This article has no price in any group. Enter one, or set it under Pricing.';

  return (
    <Modal
      open
      size="sm"
      modalHeading={editing ? 'Edit stock item' : 'Add from inventory'}
      modalLabel={order.reference}
      primaryButtonText={mutation.isPending ? 'Saving…' : editing ? 'Save item' : 'Add item'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || (!editing && !article)}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        {item ? (
          <p>
            <strong>{item.description}</strong>
          </p>
        ) : (
          <FuzzyComboBox<Material>
            autoAlign
            id="order-article"
            titleText="Article"
            placeholder={articles.isPending ? 'Loading articles…' : 'Search articles'}
            items={choices}
            selectedItem={article}
            itemToString={articleLabel}
            itemToElement={(candidate) =>
              candidate ? (
                <span className="sales-option">
                  <span>{articleLabel(candidate)}</span>
                  <span className="sales-secondary">
                    {formatQuantity(candidate.unassignedQuantity, 6)}{' '}
                    {articleUnitLabel(candidate.unit, candidate.countLabel)} in stock ·{' '}
                    {candidate.prices.length
                      ? candidate.prices
                          .map((entry) => priceText(entry, articleUnitLabel(candidate.unit, candidate.countLabel)))
                          .join(' · ')
                      : 'no price'}
                  </span>
                </span>
              ) : null
            }
            invalid={articles.isError}
            invalidText="The articles could not be loaded."
            onChange={({ selectedItem }) => selectArticle(selectedItem ?? null)}
          />
        )}
        {article && (
          <div className="sales-tags" aria-label="Prices per pricing group">
            {article.prices.length === 0 ? (
              <Tag type="red" size="sm">
                No price
              </Tag>
            ) : (
              article.prices.map((entry) => (
                <Tag key={entry.pricingGroupId} type={group?.id === entry.pricingGroupId ? 'blue' : 'gray'} size="sm">
                  {priceText(entry, articleUnitLabel(article.unit, article.countLabel))}
                </Tag>
              ))
            )}
          </div>
        )}
        <TextInput
          id="stock-quantity"
          labelText={unit ? `Quantity (${unit})` : 'Quantity'}
          inputMode="decimal"
          invalid={!!errors.quantity}
          invalidText={errors.quantity?.message}
          {...form.register('quantity', {
            required: 'Required',
            validate: (value) => {
              const parsed = parseDecimalInput(value);
              return parsed === null ? 'Use a number, e.g. 2 or 1.5' : Number(parsed) > 0 || 'Must be more than zero';
            },
          })}
        />
        {short && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Low stock"
            subtitle={`Only ${formatQuantity(article.unassignedQuantity, 6)} ${articleUnitLabel(article.unit, article.countLabel)} in loose stock — finalizing will fail until stock is received.`}
          />
        )}
        <TextInput
          id="stock-unit-price"
          labelText={editing ? 'Unit price (€)' : 'Unit price (€, optional)'}
          inputMode="decimal"
          placeholder={editing ? undefined : 'Price of the customer’s group'}
          invalid={!!errors.unitPrice}
          invalidText={errors.unitPrice?.message}
          helperText={priceHelper}
          {...form.register('unitPrice', {
            validate: (value) =>
              value.trim() === ''
                ? !editing || 'Required'
                : parseDecimalInput(value) !== null || 'Use a decimal amount, e.g. 4.50',
          })}
        />
        <p>
          Amount:{' '}
          <strong>
            {amount !== null
              ? formatCents(amount)
              : unitPriceText.trim() === '' && !editing
                ? 'quantity × group price'
                : '—'}
          </strong>
        </p>
        {missing && (
          <RichNotification kind="error" title="No price for this customer">
            {article?.name ?? 'This article'} has no price in the{' '}
            {missing.pricingGroup ? `${missing.pricingGroup} pricing group` : 'customer’s pricing group'}. Enter a unit
            price, or set the price under Articles sold from stock in{' '}
            {hasPermission(user, PermissionId.pricingread) ? (
              <CarbonLink as={Link} to="/pricing">
                Pricing
              </CarbonLink>
            ) : (
              'Pricing'
            )}
            .
          </RichNotification>
        )}
        {mutation.error && !missing && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not save"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
