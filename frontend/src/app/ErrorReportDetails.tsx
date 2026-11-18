import { useEffect, useRef, useState } from 'react';
import { Accordion, AccordionItem, Button, CodeSnippet, InlineNotification, Stack } from '@carbon/react';
import { formatErrorDetails } from './errorDetails';
import type { ErrorSummary } from './errorSummary';

type Props = { error: unknown; summary: ErrorSummary; componentStack?: string };
type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The technical details of a crash, collapsed, with a copy button. Loaded only when a page crashed, so it stays out of
 * the initial bundle. Nothing leaves the browser unless the person copies it.
 */
export default function ErrorReportDetails({ error, summary, componentStack }: Props) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [open, setOpen] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  const details = formatErrorDetails(error, summary, componentStack);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy() {
    window.clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(details);
      setCopyState('copied');
      resetTimer.current = window.setTimeout(() => setCopyState('idle'), 3000);
    } catch {
      setCopyState('failed');
      setOpen(true);
    }
  }

  return (
    <Stack gap={5}>
      <p className="error-report__help">
        If this keeps happening, copy the details and include them when you report the problem.
      </p>
      <div>
        <Button kind="tertiary" size="md" onClick={() => void copy()}>
          {copyState === 'copied' ? 'Details copied' : 'Copy details'}
        </Button>
        <p className="visually-hidden" aria-live="polite">
          {copyState === 'copied' ? 'Error details copied to the clipboard.' : ''}
        </p>
      </div>
      {copyState === 'failed' && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Could not copy automatically."
          subtitle="Select the technical details below and copy them by hand."
        />
      )}
      <Accordion>
        <AccordionItem title="Technical details" open={open} onHeadingClick={({ isOpen }) => setOpen(isOpen)}>
          <CodeSnippet type="multi" hideCopyButton wrapText aria-label="Technical details">
            {details}
          </CodeSnippet>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
}
