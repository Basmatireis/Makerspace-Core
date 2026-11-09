import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { createPricingRule, deletePricingRule, updatePricingRule } from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { useNotify } from '../../app/toasts';
import { parseDecimalInput } from '../orders/money';
import { rateText, useRefresh } from './pricingShared';
import { fallbackOf, inheritedOf, ruleOf, selectorName, type RateSelector } from './selectors';

/**
 * Sets the rate of one row for one pricing group: creates the rule, changes its rate, or, for an article, removes its
 * own price when the field is emptied (the rule is deleted, so the article falls back to its type rate or is no
 * longer sold to that group).
 */
export function SetRateModal({
  group,
  selector,
  onClose,
}: {
  group: PricingGroup;
  selector: RateSelector;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const notify = useNotify();
  const rule = ruleOf(group, selector);
  const article = selector.kind === 'stock_article';
  const variant = !!selector.materialTypeVariantId;
  const fallback = article ? fallbackOf(group, selector) : variant ? inheritedOf(group, selector) : undefined;
  const name = selectorName(selector);
  const [text, setText] = useState(rule ? rateText(rule.rate) : '');
  const parsed = parseDecimalInput(text);
  const removing = (article || variant) && !!rule && text.trim() === '';
  const mutation = useMutation({
    mutationFn: async () => {
      if (rule && removing) {
        try {
          await deletePricingRule(rule.id, { expectedVersion: rule.version });
        } catch (error) {
          if (error instanceof ApiError && error.data?.code === 'stale_write')
            throw new Error('The rate changed meanwhile. Reload and try again.', { cause: error });
          throw error;
        }
        return;
      }
      const target = {
        kind: selector.kind,
        processId: selector.processId ?? null,
        materialTypeId: selector.materialTypeId ?? null,
        // Only material rules take a variant; the API rejects the field on other kinds.
        ...(selector.kind === 'material' ? { materialTypeVariantId: selector.materialTypeVariantId ?? null } : {}),
        materialId: selector.materialId ?? null,
        measure: selector.measure ?? null,
      };
      if (rule)
        return updatePricingRule(rule.id, {
          ...target,
          rate: parsed!,
          active: rule.active,
          expectedVersion: rule.version,
        });
      return createPricingRule(group.id, { ...target, rate: parsed! });
    },
    onSuccess: async () => {
      await refresh();
      if (removing) notify({ kind: 'success', title: 'Rate removed', subtitle: name });
      onClose();
    },
  });
  const invalid = text.trim() !== '' && parsed === null;
  const helper = article
    ? fallback
      ? `Charged when the article is sold to this group. Empty uses the rate of its material type, ${rateText(fallback.rate)} ${selector.unit}.`
      : 'Charged when the article is sold on an order to this group; empty means it cannot be sold to them.'
    : variant
      ? fallback
        ? `Charged for this variant. Empty uses the rate of ${selector.parentLabel}, ${rateText(fallback.rate)} ${selector.unit}.`
        : `Charged for this variant. ${selector.parentLabel} has no rate in this group yet.`
      : 'An explicit 0 means free.';
  return (
    <Modal
      open
      size="sm"
      modalHeading="Set rate"
      modalLabel={`${group.name} · ${name}`}
      primaryButtonText={
        mutation.isPending ? 'Saving…' : removing ? (variant ? 'Remove variant rate' : 'Remove price') : 'Save rate'
      }
      secondaryButtonText="Cancel"
      danger={removing}
      primaryButtonDisabled={mutation.isPending || (!removing && parsed === null)}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <TextInput
          id={`rate-${group.id}-${selector.key}`}
          labelText={`Rate for ${name} in ${group.name} (${selector.unit})`}
          inputMode="decimal"
          value={text}
          data-modal-primary-focus
          placeholder={fallback ? rateText(fallback.rate) : undefined}
          invalid={invalid}
          invalidText="Use a decimal number, e.g. 0,08"
          helperText={helper}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="sales-secondary">{selector.description}</p>
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Rate not saved"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
