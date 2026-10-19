import { NumberInput, Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import { DateInput as AppDateInput } from '../../../../app/DateInput';
import { MACHINE_KEYS, MACHINE_NAMES } from '../engine';
import type { AnnouncementField } from '../types';

type InputProps = { id: string; label: string; value: string; onChange: (value: string) => void; helper?: string; invalid?: boolean; invalidText?: string };

/** The app's shared date input (typed d.m.Y or calendar) for a `YYYY-MM-DD` value, plus helper text. */
export function DateInput({ id, label, value, onChange, helper, invalid, invalidText }: InputProps) {
  return (
    <div>
      <AppDateInput id={id} labelText={label} value={value} onChange={onChange} invalid={invalid} invalidText={invalidText} />
      {helper && <p className="mj-secondary">{helper}</p>}
    </div>
  );
}

/** Date (Carbon date picker) and time (time input) side by side for a `YYYY-MM-DDTHH:MM` value. */
export function DateTimeInput({ id, label, value, onChange, helper, invalid, invalidText }: InputProps) {
  const [day = '', time = ''] = value.split('T');
  const change = (nextDay: string, nextTime: string) => onChange(nextDay === '' ? '' : `${nextDay}T${nextTime || '10:00'}`);
  return (
    <fieldset className="sg-datetime">
      <legend className="cds--label">{label}</legend>
      <div className="sg-form-row">
        <DateInput id={`${id}-date`} label="Date" value={day} onChange={(nextDay) => change(nextDay, time)} invalid={invalid} invalidText={invalidText} />
        <TextInput id={`${id}-time`} type="time" labelText="Time" value={time} disabled={day === ''} onChange={(event) => change(day, event.target.value)} />
      </div>
      {helper && <p className="mj-secondary">{helper}</p>}
    </fieldset>
  );
}

/** The input a template field renders as when someone starts an announcement. */
export function AnnouncementFieldInput({ field, id, value, onChange, invalid }: { field: AnnouncementField; id: string; value: string; onChange: (value: string) => void; invalid: boolean }) {
  const label = field.required ? field.label : `${field.label} (optional)`;
  const common = { helper: field.helper || undefined, invalid, invalidText: 'This field is required' };
  switch (field.type) {
    case 'text': return <TextInput id={id} labelText={label} helperText={common.helper} value={value} invalid={invalid} invalidText={common.invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'longtext': return <TextArea id={id} labelText={label} helperText={common.helper} rows={3} value={value} invalid={invalid} invalidText={common.invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'time': return <TextInput id={id} type="time" labelText={label} helperText={common.helper} value={value} invalid={invalid} invalidText={common.invalidText} onChange={(event) => onChange(event.target.value)} />;
    case 'date': return <DateInput id={id} label={label} value={value} onChange={onChange} {...common} />;
    case 'datetime': return <DateTimeInput id={id} label={label} value={value} onChange={onChange} {...common} />;
    case 'number': return <NumberInput id={id} label={label} helperText={common.helper} allowEmpty value={value === '' ? '' : Number(value)} invalid={invalid} invalidText={common.invalidText} onChange={(_, { value: next }) => onChange(next === '' || next === undefined ? '' : String(next))} />;
    case 'choice': return (
      <Select id={id} labelText={label} helperText={common.helper} value={value} invalid={invalid} invalidText={common.invalidText} onChange={(event) => onChange(event.target.value)}>
        <SelectItem value="" text="Choose…" />
        {field.options.map((option) => <SelectItem key={option} value={option} text={option} />)}
      </Select>
    );
    case 'machine': return (
      <Select id={id} labelText={label} helperText={common.helper} value={value} invalid={invalid} invalidText={common.invalidText} onChange={(event) => onChange(event.target.value)}>
        <SelectItem value="" text="Choose…" />
        {MACHINE_KEYS.map((key) => <SelectItem key={key} value={key} text={MACHINE_NAMES[key]} />)}
      </Select>
    );
  }
}
