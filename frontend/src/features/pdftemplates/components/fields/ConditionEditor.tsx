import { useId } from 'react';
import { OP_LABELS, type Condition, type ConditionOp } from '../../model';
import { conditionPaths } from '../../variables';
import { SelectField, TextField, type Change } from './Inputs';
import { usePanel } from './panelContext';

const OPS: ConditionOp[] = ['exists', 'empty', 'eq', 'ne', 'gt', 'lt'];
const OP_TEXT: Record<ConditionOp, string> = { ...OP_LABELS, gt: 'is greater than', lt: 'is less than' };

/** "Show only when <value> <is set | equals | …> <compare with>". Values come from the export's schema and the loops. */
export function ConditionEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: Condition;
  onChange: Change<Condition>;
}) {
  const { doc, schema } = usePanel();
  const id = useId();
  const paths = conditionPaths(doc, schema);
  // A path the schema does not know (typed by hand in an older document) stays selectable instead of vanishing.
  const known = !value.path || paths.includes(value.path) ? paths : [value.path, ...paths];
  const needsValue = value.op !== 'exists' && value.op !== 'empty';
  return (
    <fieldset className="pdft-cond" aria-labelledby={`${id}-t`}>
      <legend id={`${id}-t`} className="cds--label">
        {title}
      </legend>
      <SelectField
        label="Value"
        value={value.path}
        options={[{ value: '', label: 'Choose a value' }, ...known.map((p) => ({ value: p, label: p }))]}
        onChange={(path, kind) => onChange({ ...value, path }, kind)}
      />
      <SelectField
        label="Comparison"
        value={value.op}
        options={OPS.map((op) => ({ value: op, label: OP_TEXT[op] }))}
        onChange={(op, kind) => onChange({ ...value, op: op as ConditionOp }, kind)}
      />
      {needsValue && (
        <TextField
          label="Compare with"
          value={value.value ?? ''}
          onChange={(text, kind) => onChange({ ...value, value: text }, kind)}
        />
      )}
    </fieldset>
  );
}
