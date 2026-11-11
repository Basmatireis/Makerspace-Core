import { Checkbox } from '@carbon/react';
import { useRef, type ReactNode } from 'react';
import { useReadToEnd } from '../../../app/pdf/useReadToEnd';
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
  // The checkbox unlocks once the PDF has been scrolled to its end; the component is keyed by revision by its callers'
  // data, and a new revision remounts the pages below, so the lock is reset with it.
  const box = useRef<HTMLDivElement>(null);
  const { read, check, unlock } = useReadToEnd();
  return (
    <div className="lab-rules-agreement">
      {/* Keyed by revision so a new revision starts a fresh render instead of appending to the old pages. */}
      <div
        className="lab-rules-agreement__pdf"
        tabIndex={0}
        role="region"
        aria-label={`Lab Rules, revision ${revision}`}
        ref={box}
        onScroll={() => check(box.current)}
      >
        <PdfPages key={`${pdfUrl}#${revision}`} url={pdfUrl} onDone={(ok) => (ok ? check(box.current) : unlock())} />
      </div>
      <Checkbox
        id={id}
        className={size === 'lg' ? 'lab-rules-agreement__checkbox--lg' : undefined}
        labelText={`I have read the Lab Rules (revision ${revision}) and agree to follow them`}
        helperText={read ? undefined : 'Scroll to the end of the Lab Rules to confirm'}
        checked={checked}
        disabled={disabled || !read}
        onChange={(_, data) => onCheckedChange(data.checked)}
      />
      {children}
    </div>
  );
}
