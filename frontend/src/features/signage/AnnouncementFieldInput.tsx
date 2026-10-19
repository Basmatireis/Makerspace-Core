import { NumberInput, Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import { DateInput, DateTimeInput } from '../../app/DateInput';
import type { SignageTemplateField } from '../../api/generated/models';
import type { MachineOption } from './preview';

type Props = { field: SignageTemplateField; id: string; value: string; onChange: (value: string) => void; invalid: boolean; machines: readonly MachineOption[] };

/** The input a template field renders as when someone starts an announcement. Dates are `YYYY-MM-DD`, date-times `YYYY-MM-DDTHH:MM`. */
export function AnnouncementFieldInput({ field, id, value, onChange, invalid, machines }: Props) {
  const label = field.required ? field.label : `${field.label} (optional)`;
  const helperText = field.helperText || undefined;
  const invalidText = 'This field is required';
  switch (field.type) {
    case 'text': return <TextInput id={id} labelText={label} helperText={helperText} maxLength={2000} value={value} invalid={invalid} invalidText={invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'longtext': return <TextArea id={id} labelText={label} helperText={helperText} rows={3} maxLength={2000} value={value} invalid={invalid} invalidText={invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'time': return <TextInput id={id} type="time" labelText={label} helperText={helperText} value={value} invalid={invalid} invalidText={invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'date': return (
      <div>
        <DateInput id={id} labelText={label} value={value} onChange={onChange} invalid={invalid} invalidText={invalidText} />
        {helperText && <p className="sg-secondary">{helperText}</p>}
      </div>
    );
    case 'datetime': return (
      <div>
        <DateTimeInput id={id} labelText={label} value={value} onChange={onChange} />
        {invalid && <p className="sg-error-text" role="alert">{invalidText}</p>}
        {helperText && <p className="sg-secondary">{helperText}</p>}
      </div>
    );
    case 'number': return <NumberInput id={id} label={label} helperText={helperText} allowEmpty value={value === '' ? '' : Number(value)} invalid={invalid} invalidText={invalidText} onChange={(_, { value: next }) => onChange(next === '' || next === undefined ? '' : String(next))} />;
    case 'choice': return (
      <Select id={id} labelText={label} helperText={helperText} value={value} invalid={invalid} invalidText={invalidText} onChange={(event) => onChange(event.target.value)}>
        <SelectItem value="" text="Choose…" />
        {field.options.map((option) => <SelectItem key={option} value={option} text={option} />)}
      </Select>
    );
    case 'machine': return (
      <Select id={id} labelText={label} helperText={helperText} value={value} invalid={invalid} invalidText={invalidText} onChange={(event) => onChange(event.target.value)}>
        <SelectItem value="" text="Choose…" />
        {machines.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
      </Select>
    );
  }
}
