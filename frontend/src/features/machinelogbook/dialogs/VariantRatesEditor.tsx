import { useState } from 'react';
import {
  Button,
  IconButton,
  InlineNotification,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
} from '@carbon/react';
import { Checkmark, Close } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPricingRule, updatePricingRule } from '../../../api/generated/pricing/pricing';
import type { MaterialType, MaterialUnit, PricingGroup, PricingRule } from '../../../api/generated/models';
import { parseDecimalInput } from '../../orders/money';
import { unitText } from '../processConfig';
import { machineLogbookKeys, pricingQuery } from '../queries';
import { useCan } from '../shared/useCan';

const rateText = (rate: string) => rate.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1').replace('.', ',');

/** The active material rule of a group for a type (variantId null: the rate of the whole type). */
const ruleOf = (group: PricingGroup, typeId: string, variantId: string | null): PricingRule | undefined =>
  group.rules.find(
    (rule) =>
      rule.active &&
      rule.kind === 'material' &&
      rule.materialTypeId === typeId &&
      (rule.materialTypeVariantId ?? null) === variantId,
  );

type Cell = { groupId: string; variantId: string | null };

/**
 * The material rates of a machine-use type per pricing group: one row for the type itself and one per variant. A
 * variant without a rule of its own inherits the rate of the type. Needs `pricing.read`; `pricing.manage` edits.
 */
export function VariantRatesEditor({ type }: { type: MaterialType }) {
  const can = useCan();
  const client = useQueryClient();
  const pricing = useQuery({ ...pricingQuery(), enabled: can('pricing.read') });
  const canManage = can('pricing.manage');
  const [editing, setEditing] = useState<Cell | null>(null);
  const [text, setText] = useState('');
  const unit = `€/${unitText(type.unit as MaterialUnit)}`;
  const groups = (pricing.data?.items ?? []).filter((group) => group.active);

  const save = useMutation({
    mutationFn: async ({
      group,
      variantId,
      rate,
      clear,
    }: Cell & { group: PricingGroup; rate: string | null; clear: boolean }) => {
      const rule = ruleOf(group, type.id, variantId);
      const target = { kind: 'material' as const, materialTypeId: type.id, materialTypeVariantId: variantId };
      if (rule)
        return updatePricingRule(rule.id, {
          ...target,
          rate: clear ? rule.rate : (rate as string),
          active: !clear,
          expectedVersion: rule.version,
        });
      return createPricingRule(group.id, { ...target, rate: rate as string });
    },
    onSuccess: async () => {
      setEditing(null);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });

  if (!can('pricing.read')) return null;
  if (groups.length === 0) {
    if (!pricing.isSuccess) return null;
    return (
      <fieldset className="inv-variants">
        <legend className="cds--label">Rates per variant</legend>
        <p className="mj-secondary">
          Rates per variant appear once a pricing group exists under{' '}
          <CarbonLink as={Link} to="/pricing" inline>
            Sales → Pricing
          </CarbonLink>
          .
        </p>
      </fieldset>
    );
  }
  const parsed = parseDecimalInput(text);
  const rows: { variantId: string | null; label: string }[] = [
    { variantId: null, label: 'All variants' },
    ...type.variants.map((variant) => ({ variantId: variant.id, label: variant.name })),
  ];

  const startEdit = (group: PricingGroup, variantId: string | null) => {
    const rule = ruleOf(group, type.id, variantId);
    setText(rule ? rateText(rule.rate) : '');
    setEditing({ groupId: group.id, variantId });
    save.reset();
  };

  return (
    <fieldset className="inv-variants">
      <legend className="cds--label">Rates per variant</legend>
      <p className="mj-secondary">
        Charged per {unitText(type.unit as MaterialUnit)} of this material used on a machine. A variant without a rate
        of its own inherits the rate of all variants.
      </p>
      <Table size="sm" aria-label={`Rates of ${type.name} per variant`} useZebraStyles={false}>
        <TableHead>
          <TableRow>
            <TableHeader>Variant</TableHeader>
            {groups.map((group) => (
              <TableHeader key={group.id}>{group.name}</TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.variantId ?? 'type'}>
              <TableCell>{row.label}</TableCell>
              {groups.map((group) => {
                const own = ruleOf(group, type.id, row.variantId);
                const inherited = row.variantId && !own ? ruleOf(group, type.id, null) : undefined;
                const cellLabel = `${row.label} in ${group.name}`;
                if (editing?.groupId === group.id && editing.variantId === row.variantId)
                  return (
                    <TableCell key={group.id}>
                      <div className="inv-variant-rate-edit">
                        <TextInput
                          id={`rate-${group.id}-${row.variantId ?? 'type'}`}
                          size="sm"
                          labelText={`Rate for ${cellLabel} (${unit})`}
                          hideLabel
                          inputMode="decimal"
                          autoFocus
                          value={text}
                          invalid={text.trim() !== '' && parsed === null}
                          invalidText="Use a decimal number, e.g. 0,08"
                          onChange={(event) => setText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && parsed !== null) {
                              event.preventDefault();
                              save.mutate({ ...editing, group, rate: parsed, clear: false });
                            }
                            if (event.key === 'Escape') {
                              event.stopPropagation();
                              setEditing(null);
                            }
                          }}
                        />
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label={`Save rate for ${cellLabel}`}
                          disabled={parsed === null || save.isPending}
                          onClick={() => save.mutate({ ...editing, group, rate: parsed, clear: false })}
                        >
                          <Checkmark />
                        </IconButton>
                        <IconButton kind="ghost" size="sm" label="Cancel" onClick={() => setEditing(null)}>
                          <Close />
                        </IconButton>
                      </div>
                    </TableCell>
                  );
                const content = own ? (
                  `${rateText(own.rate)} ${unit}`
                ) : inherited ? (
                  <span className="mj-secondary">
                    {rateText(inherited.rate)} {unit} · inherited
                  </span>
                ) : (
                  <span className="mj-secondary">No rate</span>
                );
                return (
                  <TableCell key={group.id}>
                    {canManage ? (
                      <div className="inv-variant-rate-edit">
                        <Button
                          kind="ghost"
                          size="sm"
                          aria-label={`Edit rate for ${cellLabel}`}
                          onClick={() => startEdit(group, row.variantId)}
                        >
                          {content}
                        </Button>
                        {own && row.variantId && (
                          <IconButton
                            kind="ghost"
                            size="sm"
                            label={`Clear rate for ${cellLabel}`}
                            disabled={save.isPending}
                            onClick={() =>
                              save.mutate({
                                groupId: group.id,
                                variantId: row.variantId,
                                group,
                                rate: null,
                                clear: true,
                              })
                            }
                          >
                            <Close />
                          </IconButton>
                        )}
                      </div>
                    ) : (
                      content
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Rate not saved"
          subtitle={save.error.message}
        />
      )}
    </fieldset>
  );
}
