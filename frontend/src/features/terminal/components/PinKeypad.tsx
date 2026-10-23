import { Button } from '@carbon/react';
import { Erase } from '@carbon/icons-react';

export function PinKeypad({
  onDigit,
  onBackspace,
  onClear,
}: {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  return (
    <div className="tablet-keypad" role="group" aria-label="PIN keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
        <Button key={digit} kind="tertiary" className="tablet-keypad__key" onClick={() => onDigit(digit)}>
          {digit}
        </Button>
      ))}
      <Button kind="ghost" className="tablet-keypad__key tablet-keypad__key--small" onClick={onClear}>
        Clear
      </Button>
      <Button kind="tertiary" className="tablet-keypad__key" onClick={() => onDigit('0')}>
        0
      </Button>
      <Button
        kind="ghost"
        className="tablet-keypad__key"
        hasIconOnly
        renderIcon={Erase}
        iconDescription="Delete last digit"
        tooltipPosition="top"
        onClick={onBackspace}
      />
    </div>
  );
}
