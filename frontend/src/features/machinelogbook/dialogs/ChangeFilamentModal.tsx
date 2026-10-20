import { FormProvider } from 'react-hook-form';
import {
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ProgressIndicator,
  ProgressStep,
  Stack,
} from '@carbon/react';
import type { FilamentSpool } from '../../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { spoolNameText } from '../components/spoolShared';
import { spoolErrorMessage } from '../spoolData';
import { FilamentStep } from './changeFilament/FilamentStep';
import { LeftoverStep, SpoolStep } from './changeFilament/SpoolSteps';
import { TagsStep } from './changeFilament/TagsStep';
import { useChangeFilamentWizard, LABELS } from './changeFilament/useChangeFilamentWizard';

/** Refill workflow: choose a spool, say what happens with its leftover, load the new filament and replace the tags. */
export function ChangeFilamentModal({
  open,
  onClose,
  spool: preselected,
}: {
  open: boolean;
  onClose: () => void;
  spool?: FilamentSpool;
}) {
  const wizard = useChangeFilamentWizard({ open, onClose, preselected });
  const {
    narrow,
    step,
    setStep,
    spoolList,
    materialList,
    productList,
    ready,
    loadFailed,
    form,
    values,
    spool,
    steps,
    current,
    last,
    mutation,
    pending,
    next,
    submit,
  } = wizard;

  return (
    <ComposedModal
      open={open}
      size="lg"
      preventCloseOnClickOutside
      onClose={() => {
        if (!pending) onClose();
      }}
      aria-label="Change filament"
    >
      <ModalHeader title="Change filament" label={spool ? spoolNameText(spool) : 'Spools'} />
      <ModalBody hasForm>
        <FormProvider {...form}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void (last ? submit() : next());
            }}
            noValidate
          >
            <Stack gap={7}>
              <ProgressIndicator
                currentIndex={Math.min(step, steps.length - 1)}
                vertical={narrow}
                spaceEqually={!narrow}
                onChange={(index: number) => {
                  if (index < step && !pending) setStep(index);
                }}
              >
                {steps.map((key) => (
                  <ProgressStep key={key} label={LABELS[key]} />
                ))}
              </ProgressIndicator>

              {mutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Not saved"
                  subtitle={spoolErrorMessage(mutation.error)}
                />
              )}
              {loadFailed && (
                <ErrorState
                  message="Spools, materials and products could not be loaded."
                  onRetry={() => {
                    void spoolList.refetch();
                    void materialList.refetch();
                    void productList.refetch();
                  }}
                />
              )}
              {!ready && !loadFailed && <InlineLoadingState label="Loading spools and products" />}

              {ready && current === 'spool' && <SpoolStep wizard={wizard} />}

              {ready && current === 'leftover' && spool && <LeftoverStep spool={spool} />}

              {ready && current === 'filament' && <FilamentStep wizard={wizard} />}

              {ready && current === 'tags' && spool && <TagsStep wizard={wizard} spool={spool} />}
            </Stack>
          </form>
        </FormProvider>
      </ModalBody>
      <ModalFooter
        primaryButtonText={last ? (pending ? 'Saving…' : 'Save') : 'Next'}
        primaryButtonDisabled={pending || !ready || (current === 'spool' && !values.spoolId)}
        {...(step > 0
          ? {
              secondaryButtons: [
                {
                  buttonText: 'Cancel',
                  onClick: () => {
                    if (!pending) onClose();
                  },
                },
                {
                  buttonText: 'Back',
                  onClick: () => {
                    if (!pending) setStep((value) => Math.max(0, value - 1));
                  },
                },
              ] as [{ buttonText: string; onClick: () => void }, { buttonText: string; onClick: () => void }],
            }
          : {
              secondaryButtonText: 'Cancel',
              onRequestClose: () => {
                if (!pending) onClose();
              },
            })}
        onRequestSubmit={() => {
          void (last ? submit() : next());
        }}
      >
        {null}
      </ModalFooter>
    </ComposedModal>
  );
}
