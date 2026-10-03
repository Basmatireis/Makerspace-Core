import { DatePicker, DatePickerInput, TimePicker } from '@carbon/react';
import {
  APP_DATE_PLACEHOLDER,
  dateOnlyToPickerDate,
  parseDisplayDate,
  pickerDateToDateOnly,
} from './dateTime';

type DateInputProps = {
  id: string;
  labelText: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  invalidText?: string;
  required?: boolean;
};

export function DateInput({ id, labelText, value, onChange, invalid, invalidText, required }: DateInputProps) {
  return (
    <DatePicker
      allowInput
      datePickerType="single"
      dateFormat="d.m.Y"
      locale="en"
      value={value ? dateOnlyToPickerDate(value) : ''}
      onChange={(dates) => onChange(dates[0] ? pickerDateToDateOnly(dates[0]) : '')}
    >
      <DatePickerInput
        id={id}
        labelText={labelText}
        placeholder={APP_DATE_PLACEHOLDER}
        pattern="\d{2}\.\d{2}\.\d{4}"
        invalid={invalid}
        invalidText={invalidText}
        aria-required={required}
        onChange={(event) => {
          const text = event.target.value;
          const parsed = parseDisplayDate(text);
          if (parsed) onChange(parsed);
          else if (!text) onChange('');
        }}
      />
    </DatePicker>
  );
}

type DateTimeInputProps = {
  id: string;
  labelText: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
};

export function DateTimeInput({ id, labelText, value, onChange, required }: DateTimeInputProps) {
  const [date = '', time = ''] = value.split('T');
  return (
    <div className="app-date-time-input">
      <DateInput
        id={`${id}-date`}
        labelText={`${labelText} date`}
        value={date}
        required={required}
        onChange={(nextDate) => onChange(nextDate ? `${nextDate}T${time}` : '')}
      />
      <TimePicker
        id={`${id}-time`}
        labelText={`${labelText} time (24-hour)`}
        placeholder="HH:MM"
        pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
        value={time}
        aria-required={required}
        onChange={(event) => onChange(event.target.value ? `${date}T${event.target.value}` : date ? `${date}T` : '')}
      />
    </div>
  );
}
