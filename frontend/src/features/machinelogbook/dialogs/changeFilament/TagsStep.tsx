import type { FilamentSpool } from '../../../../api/generated/models';
import { Controller } from 'react-hook-form';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { leftoverSummary } from '../../components/LeftoverFields';
import { formatGrams } from '../../components/inventoryShared';
import { identifierKinds, identifierLabel } from '../../components/spoolShared';
import { type ChangeFilamentWizard, blankTag } from './useChangeFilamentWizard';

export function TagsStep({ wizard, spool }: { wizard: ChangeFilamentWizard; spool: FilamentSpool }) {
  const { fields, append, remove, values, leftover, material, net, stock, taken, review, errors, control, register } =
    wizard;

  return (
    <Stack gap={6}>
      {spool.identifiers.length > 0 ? (
        <Controller
          control={control}
          name="keep"
          render={({ field }) => (
            <CheckboxGroup
              legendText="Keep on this spool"
              helperText="Unchecked tags stay in the history of the old fill. NFC tags are replaced with every refill."
            >
              {spool.identifiers.map((identifier) => (
                <Checkbox
                  key={identifier.id}
                  id={`refill-keep-${identifier.id}`}
                  labelText={`${identifierLabel(identifier.kind)} ${identifier.value}`}
                  checked={Boolean(field.value[identifier.id])}
                  onChange={(_event, { checked }) => field.onChange({ ...field.value, [identifier.id]: checked })}
                />
              ))}
            </CheckboxGroup>
          )}
        />
      ) : (
        <p className="mj-secondary">This spool has no identifiers yet.</p>
      )}
      <fieldset className="mj-fieldset">
        <legend className="cds--label">New identifiers</legend>
        <Stack gap={5}>
          {fields.map((field, index) => (
            <div className="mj-identifier-row" key={field.id}>
              <Select id={`refill-tag-kind-${index}`} labelText="Kind" {...register(`added.${index}.kind`)}>
                {identifierKinds.map((kind) => (
                  <SelectItem key={kind.id} value={kind.id} text={kind.label} />
                ))}
              </Select>
              <TextInput
                id={`refill-tag-value-${index}`}
                labelText="Value"
                autoComplete="off"
                helperText={index === 0 ? 'As printed or read by the scanner. Leave empty to add no tag.' : undefined}
                invalid={Boolean(errors.added?.[index]?.value)}
                invalidText={errors.added?.[index]?.value?.message}
                {...register(`added.${index}.value`, {
                  validate: (value, form) => taken(form.added[index]?.kind ?? 'nfc', value, index) ?? true,
                })}
              />
              <Button
                hasIconOnly
                kind="ghost"
                renderIcon={TrashCan}
                iconDescription={`Remove identifier row ${index + 1}`}
                tooltipPosition="left"
                onClick={() => remove(index)}
              />
            </div>
          ))}
          <div>
            <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => append(blankTag())}>
              Add identifier
            </Button>
          </div>
        </Stack>
      </fieldset>
      <section aria-labelledby="refill-review-title">
        <h3 id="refill-review-title" className="cds--label">
          Review
        </h3>
        <StructuredListWrapper isCondensed aria-label="Changes that will be saved">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Change</StructuredListCell>
              <StructuredListCell head>Details</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {review.map((row) => (
              <StructuredListRow key={row.key}>
                <StructuredListCell noWrap>{row.change}</StructuredListCell>
                <StructuredListCell>{row.detail}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
        {leftover?.complete && leftover.choice.basis === 'weighed' && (
          <p className="mj-secondary">{leftoverSummary(spool, leftover.choice)}</p>
        )}
        {material && (
          <p className="mj-secondary">
            {material.name} total after saving:{' '}
            {formatGrams(values.source === 'purchase' ? stock.total + net : stock.total)}.
          </p>
        )}
      </section>
    </Stack>
  );
}
