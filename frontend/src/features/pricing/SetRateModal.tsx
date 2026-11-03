import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { createPricingRule, updatePricingRule } from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { parseDecimalInput } from '../orders/money';
import { rateText, useRefresh } from './pricingShared';
import { fallbackOf, ruleOf, type RateSelector } from './selectors';

/**
 * Sets the rate of one row for one pricing group: creates the rule, changes its rate, or, for an article, removes its
 * own price when the field is emptied (the rule is deactivated, so the article falls back to its type rate or is no
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
  const rule = ruleOf(group, selector);
  const article = selector.kind === 'stock_article';
  const fallback = article ? fallbackOf(group, selector) : undefined;
  const [text, setText] = useState(rule ? rateText(rule.rate) : '');
  const parsed = parseDecimalInput(text);
  const removing = article && !!rule && text.trim() === '';
  const mutation = useMutation({
    mutationFn: () => {
      const target = {
        kind: selector.kind,
        processId: selector.processId ?? null,
        materialTypeId: selector.materialTypeId ?? null,
        materialId: selector.materialId ?? null,
        measure: selector.measure ?? null,
      };
      if (rule)
        return updatePricingRule(rule.id, {
          ...target,
          rate: removing ? rule.rate : parsed!,
          active: !removing,
          expectedVersion: rule.version,
        });
      return createPricingRule(group.id, { ...target, rate: parsed! });
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const invalid = text.trim() !== '' && parsed === null;
  const helper = article
    ? fallback
      ? `Charged when the article is sold to this group. Empty uses the rate of its material type, ${rateText(fallback.rate)} ${selector.unit}.`
      : 'Charged when the article is sold on an order to this group; empty means it cannot be sold to them.'
    : 'An explicit 0 means free.';
  return (
    <Modal
      open
      size="sm"
      modalHeading="Set rate"
      modalLabel={group.name}
      primaryButtonText={mutation.isPending ? 'Saving…' : removing ? 'Remove price' : 'Save rate'}
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
          labelText={`Rate for ${selector.label} in ${group.name} (${selector.unit})`}
          inputMode="decimal"
          value={text}
          autoFocus
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
