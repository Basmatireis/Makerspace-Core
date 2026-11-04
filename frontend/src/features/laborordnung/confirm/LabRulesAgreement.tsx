import { Checkbox } from '@carbon/react';
import type { ReactNode } from 'react';
import { PdfPages } from '../../../app/pdf/PdfPages';
import './confirm.scss';

/**
 * The Lab Rules PDF with the agreement checkbox, shared by the app modal, the confirm page and the kiosk. The caller
 * owns the checked state and supplies the action buttons as children, so each surface decides what confirming does.
 */
export function LabRulesAgreement({
  id,
  revision,
  pdfUrl,
  checked,
  onCheckedChange,
  disabled,
  size,
  children,
}: {
  id: string;
  revision: string;
  pdfUrl: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'md' | 'lg';
  children?: ReactNode;
}) {
  return (
    <div className="lab-rules-agreement">
      {/* Keyed by revision so a new revision starts a fresh render instead of appending to the old pages. */}
      <div
        className="lab-rules-agreement__pdf"
        tabIndex={0}
        role="region"
        aria-label={`Lab Rules, revision ${revision}`}
      >
        <PdfPages key={`${pdfUrl}#${revision}`} url={pdfUrl} />
      </div>
      <Checkbox
        id={id}
        className={size === 'lg' ? 'lab-rules-agreement__checkbox--lg' : undefined}
        labelText={`I have read the Lab Rules (revision ${revision}) and agree to follow them`}
        checked={checked}
        disabled={disabled}
        onChange={(_, data) => onCheckedChange(data.checked)}
      />
      {children}
    </div>
  );
}
