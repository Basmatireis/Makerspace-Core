import {
  Button,
  IconButton,
  MultiSelect,
  NumberInput,
  Select,
  SelectItem,
  SelectItemGroup,
  TextInput,
} from '@carbon/react';
import { Add, Close, Folder, TrashCan } from '@carbon/icons-react';
import type {
  NotificationCatalogField,
  NotificationCondition,
  NotificationConditionSet,
} from '../../../api/generated/models';
import { defaultCondition, isLeaf, isMultiOp, normalizeCondition, operatorsFor, type FieldGroup } from '../ruleModel';

const asNumber = (value: string | number, fallback = 0) =>
  value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);

type RowProps = {
  id: string;
  condition: NotificationCondition;
  groups: FieldGroup[];
  onChange: (next: NotificationCondition) => void;
  onRemove: () => void;
};

function ConditionRow({ id, condition, groups, onChange, onRemove }: RowProps) {
  const flat = groups.flatMap((group) => group.fields);
  const field: NotificationCatalogField | undefined =
    flat.find((candidate) => candidate.key === condition.field) ?? flat[0];
  if (!field) return null;
  const operators = operatorsFor(field.type);
  const sameKind = flat.filter(
    (other) => other.type === 'number' && other.key !== field.key && other.key.slice(0, 2) === field.key.slice(0, 2),
  );
  const set = (patch: Partial<NotificationCondition>) => onChange({ ...condition, ...patch });
  const optionItems = field.options;
  const multiSelected = optionItems.filter((option) =>
    Array.isArray(condition.value) ? (condition.value as string[]).includes(option.value) : false,
  );

  let value = null;
  if (field.type === 'enum' || field.type === 'ordered' || field.type === 'list') {
    value = isMultiOp(condition.op) ? (
      <MultiSelect
        id={`${id}-value`}
        titleText="Values"
        hideLabel
        label="Choose values"
        size="md"
        items={optionItems}
        itemToString={(option) => option?.label ?? ''}
        selectedItems={multiSelected}
        onChange={({ selectedItems }) => set({ value: (selectedItems ?? []).map((option) => option.value) })}
      />
    ) : (
      <Select
        id={`${id}-value`}
        labelText="Value"
        hideLabel
        value={String(condition.value ?? '')}
        onChange={(event) => set({ value: event.target.value })}
      >
        {optionItems.map((option) => (
          <SelectItem key={option.value} value={option.value} text={option.label} />
        ))}
      </Select>
    );
  } else if (field.type === 'number') {
    value = (
      <div className="nc-cond__number">
        {sameKind.length > 0 && condition.op !== 'between' && (
          <Select
            id={`${id}-ref`}
            labelText="Compare with"
            hideLabel
            value={condition.ref ?? ''}
            onChange={(event) => set({ ref: event.target.value || null })}
          >
            <SelectItem value="" text="a number" />
            {sameKind.map((other) => (
              <SelectItem key={other.key} value={other.key} text={other.label} />
            ))}
          </Select>
        )}
        {!condition.ref && (
          <NumberInput
            id={`${id}-number`}
            label="Value"
            hideLabel
            allowEmpty
            value={typeof condition.value === 'number' ? condition.value : ''}
            onChange={(_event, state) => set({ value: asNumber(state.value) })}
          />
        )}
        {!condition.ref && condition.op === 'between' && (
          <>
            <span className="nc-cond__unit">and</span>
            <NumberInput
              id={`${id}-number2`}
              label="Upper value"
              hideLabel
              allowEmpty
              value={condition.value2 ?? ''}
              onChange={(_event, state) => set({ value2: asNumber(state.value) })}
            />
          </>
        )}
        {field.unit && <span className="nc-cond__unit">{field.unit}</span>}
      </div>
    );
  } else if (field.type === 'text' && condition.op !== 'empty' && condition.op !== 'notempty') {
    value = (
      <TextInput
        id={`${id}-text`}
        labelText="Value"
        hideLabel
        value={String(condition.value ?? '')}
        onChange={(event) => set({ value: event.target.value })}
      />
    );
  }

  return (
    <div className="nc-cond">
      <Select
        id={`${id}-field`}
        labelText="Field"
        hideLabel
        value={field.key}
        onChange={(event) => {
          const next = flat.find((candidate) => candidate.key === event.target.value);
          if (next) onChange(normalizeCondition(next, { field: next.key, op: operatorsFor(next.type)[0].value }));
        }}
      >
        {groups.map((group) => (
          <SelectItemGroup key={group.label} label={group.label}>
            {group.fields.map((candidate) => (
              <SelectItem key={candidate.key} value={candidate.key} text={candidate.label} />
            ))}
          </SelectItemGroup>
        ))}
      </Select>
      <Select
        id={`${id}-op`}
        labelText="Comparison"
        hideLabel
        value={condition.op}
        onChange={(event) => onChange(normalizeCondition(field, { ...condition, op: event.target.value }))}
      >
        {operators.map((operator) => (
          <SelectItem key={operator.value} value={operator.value} text={operator.label} />
        ))}
      </Select>
      <div className="nc-cond__value">{value}</div>
      <IconButton kind="ghost" size="md" label="Remove condition" align="left" onClick={onRemove}>
        <Close />
      </IconButton>
    </div>
  );
}

type ListProps = {
  id: string;
  set: NotificationConditionSet;
  groups: FieldGroup[];
  /** Lead-in of the mode line, e.g. "Continue only if". */
  lead: string;
  allowGroups: boolean;
  onChange: (next: NotificationConditionSet) => void;
};

const joinWord = (mode: string) => (mode === 'all' ? 'and' : 'or');

/** The condition rows of a rule (or of a summary filter): all/any, rows, and one level of groups. */
export function ConditionList({ id, set, groups, lead, allowGroups, onChange }: ListProps) {
  const replace = (index: number, item: NotificationConditionSet['items'][number]) =>
    onChange({ ...set, items: set.items.map((existing, i) => (i === index ? item : existing)) });
  const remove = (index: number) => onChange({ ...set, items: set.items.filter((_, i) => i !== index) });
  const addTo = (index: number | null) => {
    const condition = defaultCondition(groups);
    if (!condition) return;
    if (index === null) return onChange({ ...set, items: [...set.items, condition] });
    const group = set.items[index].group;
    if (group) replace(index, { group: { ...group, items: [...group.items, condition] } });
  };
  const addGroup = () => {
    const condition = defaultCondition(groups);
    if (condition) onChange({ ...set, items: [...set.items, { group: { mode: 'any', items: [condition] } }] });
  };
  return (
    <div className="nc-conds">
      {set.items.length > 0 && (
        <div className="nc-modeline">
          <span>{lead}</span>
          <Select
            id={`${id}-mode`}
            labelText="Match mode"
            hideLabel
            size="sm"
            inline
            value={set.mode}
            onChange={(event) => onChange({ ...set, mode: event.target.value })}
          >
            <SelectItem value="all" text="all" />
            <SelectItem value="any" text="any" />
          </Select>
          <span>of these are true</span>
        </div>
      )}
      {set.items.map((item, index) => (
        <div key={index} className="nc-conds__item">
          {index > 0 && <span className="nc-conds__join">{joinWord(set.mode)}</span>}
          {isLeaf(item) ? (
            <ConditionRow
              id={`${id}-${index}`}
              condition={item as NotificationCondition}
              groups={groups}
              onChange={(next) => replace(index, next)}
              onRemove={() => remove(index)}
            />
          ) : (
            <div className="nc-group">
              <div className="nc-modeline">
                <Folder size={16} />
                <span>Group:</span>
                <Select
                  id={`${id}-${index}-mode`}
                  labelText="Group match mode"
                  hideLabel
                  size="sm"
                  inline
                  value={item.group!.mode}
                  onChange={(event) => replace(index, { group: { ...item.group!, mode: event.target.value } })}
                >
                  <SelectItem value="any" text="any" />
                  <SelectItem value="all" text="all" />
                </Select>
                <span>of these</span>
                <IconButton kind="ghost" size="sm" label="Remove group" align="left" onClick={() => remove(index)}>
                  <TrashCan />
                </IconButton>
              </div>
              {item.group!.items.map((inner, innerIndex) => (
                <div key={innerIndex} className="nc-conds__item">
                  {innerIndex > 0 && <span className="nc-conds__join">{joinWord(item.group!.mode)}</span>}
                  <ConditionRow
                    id={`${id}-${index}-${innerIndex}`}
                    condition={inner}
                    groups={groups}
                    onChange={(next) =>
                      replace(index, {
                        group: {
                          ...item.group!,
                          items: item.group!.items.map((c, i) => (i === innerIndex ? next : c)),
                        },
                      })
                    }
                    onRemove={() => {
                      const remaining = item.group!.items.filter((_, i) => i !== innerIndex);
                      if (remaining.length) replace(index, { group: { ...item.group!, items: remaining } });
                      else remove(index);
                    }}
                  />
                </div>
              ))}
              <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => addTo(index)}>
                Add condition to group
              </Button>
            </div>
          )}
        </div>
      ))}
      <div className="nc-actions-row">
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => addTo(null)}>
          Add condition
        </Button>
        {allowGroups && (
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={addGroup}>
            Add group
          </Button>
        )}
      </div>
    </div>
  );
}
