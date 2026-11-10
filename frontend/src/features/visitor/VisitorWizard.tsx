import {
  Button,
  Checkbox,
  Form,
  InlineNotification,
  Modal,
  ProgressIndicator,
  ProgressStep,
  TextInput,
  Toggle,
} from '@carbon/react';
import { ArrowLeft, ArrowRight } from '@carbon/icons-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  submitVisitorEnrollment,
  type getVisitorEnrollmentState,
} from '../../api/generated/visitor-enrollment/visitor-enrollment';
import { apiErrorCode } from '../../api/http-client';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { BrandMark } from '../../app/BrandMark';
import { usePageTitle, useBranding } from '../branding/branding';
import { LegalDocumentLink, LegalLinks } from '../branding/LegalLinks';
import { EnrollmentDone, type EnrollmentOutcome } from './components/EnrollmentDone';
import { LabRulesModal } from './components/LabRulesModal';
import { ProfilePhotoPicker, type ProfileImage } from './components/ProfilePhotoPicker';
import { useKeyboardAvoidance } from '../kiosk/useKeyboardAvoidance';
import { useInactivityPrompt } from './useInactivityPrompt';
import './visitor.scss';

const idleSeconds = 30;
const graceSeconds = 30;
// TODO(email-code enrollment): the email-verification step (POST /visitor-enrollment/email-verification and
// /confirm) is not built yet; the submission needs a verified address on the context.
type StepKey = 'about' | 'messages' | 'rules';
const stepTitles: Record<StepKey, string> = {
  about: 'About you',
  messages: 'Messages',
  rules: 'Lab Rules',
};
const emailPattern = /^\S+@\S+\.\S+$/;

type EnrollmentState = Awaited<ReturnType<typeof getVisitorEnrollmentState>>;

// Up to four steps that each fit one tablet screen. Messages asks the notification consent of a tablet check-in, so a
// new visitor answers it right away; it is left out when no category needs consent. The Lab Rules step appears only
// when the Visitor role asks for them, because only then does enrollment record the confirmation. All entries live
// only in this component: leaving the page (back, Done or inactivity) unmounts it, which releases the camera and
// discards everything.
function BrandLockup() {
  const branding = useBranding();
  return (
    <div className="visitor-flow__header-end">
      <LegalLinks />
      <p className="visitor-flow__brand">
        <BrandMark kind="logo" className="visitor-flow__logo" />
        <span>{branding.identity.displayName}</span>
      </p>
    </div>
  );
}

export function VisitorWizard({ state }: { state: EnrollmentState }) {
  usePageTitle('Visitor enrollment');
  useKeyboardAvoidance();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const steps: StepKey[] = [
    'about',
    ...(state.consentCategories.length > 0 ? (['messages'] as const) : []),
    ...(state.labRulesRequired ? (['rules'] as const) : []),
  ];
  const current = steps[step];
  const lastStep = steps.length - 1;
  const [rulesOpen, setRulesOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [image, setImage] = useState<ProfileImage>();
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);
  const [rulesChanged, setRulesChanged] = useState(false);
  const [outcome, setOutcome] = useState<EnrollmentOutcome>();
  const mutation = useSecretMutation(submitVisitorEnrollment, { gcTime: 0 });

  const toKiosk = () => void navigate('/kiosk', { replace: true });
  const inactivity = useInactivityPrompt({
    idleSeconds,
    graceSeconds,
    enabled: !outcome,
    onTimeout: toKiosk,
  });

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  // The kiosk device decides how a photo can be provided; one that can neither take nor upload one skips the step.
  // The backend applies the same rule from the device's capabilities.
  const sources = { camera: state.capabilities.includes('camera'), upload: state.capabilities.includes('file_upload') };
  const photoRequired = sources.camera || sources.upload;
  const emailValid = emailPattern.test(email.trim());
  const names = { firstName: firstName.trim(), lastName: lastName.trim() };

  const valid: Record<StepKey, boolean> = {
    about: names.firstName !== '' && names.lastName !== '' && emailValid && (!photoRequired || Boolean(image)),
    // Nothing is preselected and every answer may be "No".
    messages: true,
    rules: ready && Boolean(state.currentLabRules),
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid[current] || mutation.isPending) return;
    if (step < lastStep) {
      setStep(step + 1);
      return;
    }
    setRulesChanged(false);
    try {
      await mutation.mutateAsync({
        firstName: names.firstName,
        lastName: names.lastName,
        profileImageBase64: image?.base64 ?? null,
        profileImageFilename: image?.filename ?? null,
        labRulesAccepted: state.labRulesRequired && ready,
        consents: state.consentCategories.map((category) => ({
          categoryId: category.id,
          granted: granted[category.id] === true,
        })),
      });
      setOutcome({
        firstName: names.firstName,
        email: email.trim(),
        labRulesConfirmed: state.labRulesRequired,
      });
      setImage(undefined);
    } catch (error) {
      if (apiErrorCode(error) === 'lab_rules_changed') {
        // A newer revision became effective while the visitor was filling in the form: load it, ask again.
        setReady(false);
        setRulesChanged(true);
        setStep(steps.indexOf('rules'));
        await queryClient.invalidateQueries({ queryKey: ['visitor-enrollment', 'state'] });
      }
      /* Other failures are rendered by the notification below. */
    }
  };

  if (outcome)
    return (
      <main className="visitor-flow">
        <header className="visitor-flow__header visitor-flow__header--done">
          <BrandLockup />
        </header>
        <EnrollmentDone outcome={outcome} onDone={toKiosk} />
      </main>
    );

  return (
    <main className="visitor-flow">
      <Form className="visitor-flow__form" onSubmit={(event) => void submit(event)}>
        <header className="visitor-flow__header">
          <Button as={Link} to="/kiosk" kind="ghost" size="lg" renderIcon={ArrowLeft}>
            Back to check-in
          </Button>
          <BrandLockup />
        </header>

        <ProgressIndicator currentIndex={step} spaceEqually aria-label="Enrollment progress">
          {steps.map((key) => (
            <ProgressStep key={key} label={stepTitles[key]} />
          ))}
        </ProgressIndicator>

        <div className="visitor-flow__body">
          <p className="visitor-flow__eyebrow">
            Visitor enrollment · Step {step + 1} of {steps.length}
          </p>
          <h1 className="visitor-flow__title" tabIndex={-1} ref={heading}>
            {stepTitles[current]}
          </h1>

          {mutation.isError && apiErrorCode(mutation.error) !== 'lab_rules_changed' && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Enrollment not completed"
              subtitle="If the login name or email already belongs to an account, check in with it instead. Otherwise review your entries and try again."
            />
          )}

          {current === 'about' && (
            <div className="visitor-flow__about">
              <div className="visitor-flow__fields">
                <p className="visitor-flow__note">
                  All fields are required. How we use your data is explained in the{' '}
                  <LegalDocumentLink kind="privacy" inline>
                    privacy policy
                  </LegalDocumentLink>
                  .
                </p>
                <div className="visitor-flow__pair">
                  <TextInput
                    id="visitor-first-name"
                    labelText="First name"
                    required
                    autoComplete="off"
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                  />
                  <TextInput
                    id="visitor-last-name"
                    labelText="Last name"
                    required
                    autoComplete="off"
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                  />
                </div>
                <TextInput
                  id="visitor-email"
                  type="email"
                  labelText="Email"
                  helperText="We contact you here, for example about your account or the Lab Rules."
                  required
                  autoComplete="off"
                  invalid={emailTouched && email.trim() !== '' && !emailValid}
                  invalidText="Enter a valid email address."
                  value={email}
                  onBlur={() => setEmailTouched(true)}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <ProfilePhotoPicker image={image} sources={sources} required={photoRequired} onChange={setImage} />
            </div>
          )}

          {current === 'messages' && (
            <div className="visitor-flow__consent">
              <p className="visitor-flow__lead">
                Which messages may we send to {email.trim()}? Nothing is preselected, and you can continue with
                everything off.
              </p>
              <div className="visitor-flow__consent-list">
                {state.consentCategories.map((category) => (
                  <div key={category.id} className="visitor-flow__consent-item">
                    <div>
                      <p className="visitor-flow__consent-name" id={`visitor-consent-name-${category.id}`}>
                        {category.name}
                      </p>
                      <p className="visitor-flow__consent-description">{category.description}</p>
                    </div>
                    <Toggle
                      id={`visitor-consent-${category.id}`}
                      size="md"
                      aria-labelledby={`visitor-consent-name-${category.id}`}
                      labelA="No"
                      labelB="Yes"
                      toggled={granted[category.id] === true}
                      onToggle={(checked) => setGranted((answers) => ({ ...answers, [category.id]: checked }))}
                    />
                  </div>
                ))}
              </div>
              <p className="visitor-flow__note">
                Messages about your account, your visits and safety in the lab are always sent. Details in the{' '}
                <LegalDocumentLink kind="privacy" inline size="sm">
                  privacy policy
                </LegalDocumentLink>
                .
              </p>
            </div>
          )}

          {current === 'rules' &&
            (state.currentLabRules ? (
              <div className="visitor-flow__rules">
                {rulesChanged && (
                  <InlineNotification
                    kind="warning"
                    lowContrast
                    hideCloseButton
                    role="alert"
                    title="The Lab Rules changed"
                    subtitle="A newer revision became effective while you were filling in the form. Please read the new revision and accept it again."
                  />
                )}
                <p className="visitor-flow__lead">
                  Read the current Lab Rules (revision {state.currentLabRules.humanRevision}). By accepting them you are
                  checked in and may use the lab.
                </p>
                <div>
                  <Button type="button" kind="secondary" onClick={() => setRulesOpen(true)}>
                    View current Lab Rules PDF
                  </Button>
                  <LabRulesModal
                    open={rulesOpen}
                    revision={state.currentLabRules.humanRevision}
                    onClose={() => setRulesOpen(false)}
                  />
                </div>
                <Checkbox
                  id="visitor-ready"
                  labelText="I have read and accept the Lab Rules"
                  checked={ready}
                  onChange={(_, data) => setReady(data.checked)}
                />
              </div>
            ) : (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="No current Lab Rules"
                subtitle="Enrollment cannot complete until an effective version is published."
              />
            ))}
        </div>

        <footer className="visitor-flow__footer">
          {step > 0 ? (
            <Button type="button" kind="secondary" size="xl" renderIcon={ArrowLeft} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            size="xl"
            renderIcon={step < lastStep ? ArrowRight : undefined}
            disabled={!valid[current] || mutation.isPending}
          >
            {step < lastStep ? 'Next' : mutation.isPending ? 'Submitting…' : 'Register and check in'}
          </Button>
        </footer>
      </Form>

      <Modal
        open={inactivity.prompting}
        size="sm"
        modalHeading="Are you still there?"
        primaryButtonText="Still here"
        secondaryButtonText="Leave"
        onRequestSubmit={inactivity.confirm}
        onRequestClose={inactivity.confirm}
        onSecondarySubmit={toKiosk}
      >
        {inactivity.prompting && (
          <p role="timer">
            Returning to check-in in {inactivity.secondsLeft} s. Everything you entered will be discarded.
          </p>
        )}
      </Modal>
    </main>
  );
}
