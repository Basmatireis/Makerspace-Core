import { Button, InlineLoading, InlineNotification, Loading, Stack } from '@carbon/react';
import { Renew } from '@carbon/icons-react';

export function FullPageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="page-state" aria-live="polite">
      <Loading withOverlay={false} description={label} />
      <span className="page-state__label">{label}</span>
    </div>
  );
}

export function InlineLoadingState({ label = 'Loading' }: { label?: string }) {
  return <InlineLoading description={label} status="active" />;
}

type ErrorStateProps = {
  title?: string;
  message: string;
  onRetry?: () => void;
};

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <Stack gap={5} className="page-state page-state--error">
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title={title}
        subtitle={message}
      />
      {onRetry && (
        <Button kind="tertiary" renderIcon={Renew} onClick={onRetry}>
          Try again
        </Button>
      )}
    </Stack>
  );
}
