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
  confirmVisitorEnrollmentEmail,
  sendVisitorEnrollmentEmailCode,
  submitVisitorEnrollment,
  type getVisitorEnrollmentState,
} from '../../api/generated/visitor-enrollment/visitor-enrollment';
import { ApiError, apiErrorCode } from '../../api/http-client';
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
const codeLength = 6;
type StepKey = 'about' | 'email' | 'code' | 'messages' | 'rules';
const stepTitles: Record<StepKey, string> = {
  about: 'About you',
  email: 'Email',
  code: 'Code',
  messages: 'Messages',
  rules: 'Lab Rules',
};
const emailPattern = /^\S+@\S+\.\S+$/;

type EmailProblem = 'invalid' | 'exists' | 'delivery' | 'unavailable' | 'limited' | 'other' | 'reverify';

const emailProblemText: Record<EmailProblem, string> = {
  invalid: "This doesn't look like a valid email address",
  exists: 'This email already has an account — go back and check in instead',
  delivery: "We couldn't send a code to this address. Check it or use another one.",
  unavailable: 'Sending email is not available right now. Please ask a supervisor for help.',
  limited: 'Too many codes were requested. Please wait a few minutes and try again.',
  other: "We couldn't send the code. Please try again.",
  reverify: 'Please confirm your email address again.',
};

function emailProblemOf(error: unknown): EmailProblem {
  switch (apiErrorCode(error)) {
    case 'email_invalid':
      return 'invalid';
    case 'authentication_identifier_exists':
      return 'exists';
    case 'email_delivery_failed':
      return 'delivery';
    case 'mail_unavailable':
      return 'unavailable';
    case 'verification_rate_limited':
      return 'limited';
    default:
      return error instanceof ApiError && error.status === 429 ? 'limited' : 'other';
  }
}

type EnrollmentState = Awaited<ReturnType<typeof getVisitorEnrollmentState>>;

// Up to five steps that each fit one tablet screen. The email is verified with a mailed code before anything is
// registered: the server creates the account with the address it verified, so the visitor signs in with it later.
// Messages asks the notification consent of a tablet check-in, so a new visitor answers it right away; it is left out
// when no category needs consent. The Lab Rules step appears only when the Visitor role asks for them, because only
// then does enrollment record the confirmation. All entries live only in this component: leaving the page (back, Done
// or inactivity) unmounts it, which releases the camera and discards everything.
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
    'email',
    'code',
    ...(state.consentCategories.length > 0 ? (['messages'] as const) : []),
    ...(state.labRulesRequired ? (['rules'] as const) : []),
  ];
  const current = steps[step];
  const lastStep = steps.length - 1;
  const [rulesOpen, setRulesOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState(state.email ?? '');
  const [emailProblem, setEmailProblem] = useState<EmailProblem>();
  // The address whose code the visitor entered (or that the server already verified for this enrollment).
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(state.emailVerified ? state.email : null);
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState('');
  const [resent, setResent] = useState(false);
  const [rulesViewed, setRulesViewed] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<ProfileImage>();
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);
  const [rulesChanged, setRulesChanged] = useState(false);
  const [outcome, setOutcome] = useState<EnrollmentOutcome>();
  const mutation = useSecretMutation(submitVisitorEnrollment, { gcTime: 0 });
  const sendMutation = useSecretMutation(sendVisitorEnrollmentEmailCode, { gcTime: 0 });
  const confirmMutation = useSecretMutation(confirmVisitorEnrollmentEmail, { gcTime: 0 });

  const toKiosk = () => void navigate('/kiosk', { replace: true });
  const inactivity = useInactivityPrompt({
    idleSeconds,
    graceSeconds,
    enabled: !outcome,
    onTimeout: toKiosk,
  });

  useEffect(() => {
    // The code is typed straight away on the tablet; every other step starts at its heading.
    if (current === 'code') codeInput.current?.focus();
    else heading.current?.focus();
  }, [step, current]);

  // The kiosk device decides how a photo can be provided; one that can neither take nor upload one skips the step.
  // The backend applies the same rule from the device's capabilities.
  const sources = { camera: state.capabilities.includes('camera'), upload: state.capabilities.includes('file_upload') };
  const photoRequired = sources.camera || sources.upload;
  const emailIsVerified = verifiedEmail !== null && verifiedEmail === email.trim();
  const pending = mutation.isPending || sendMutation.isPending || confirmMutation.isPending;
  const names = { firstName: firstName.trim(), lastName: lastName.trim() };

  const valid: Record<StepKey, boolean> = {
    about: names.firstName !== '' && names.lastName !== '' && (!photoRequired || Boolean(image)),
    email: email.trim() !== '',
    code: code.length === codeLength,
    // Nothing is preselected and every answer may be "No".
    messages: true,
    rules: rulesViewed && ready && Boolean(state.currentLabRules),
  };

  // Mails a code to the entered address; the visitor cannot proceed until the server accepted the request.
  const sendCode = async (resend: boolean) => {
    const address = email.trim();
    if (!emailPattern.test(address)) {
      setEmailProblem('invalid');
      return;
    }
    setEmailProblem(undefined);
    setResent(false);
    try {
      await sendMutation.mutateAsync({ email: address });
    } catch (error) {
      if (resend) setStep(steps.indexOf('email'));
      setEmailProblem(emailProblemOf(error));
      return;
    }
    setCodeSentTo(address);
    setCode('');
    confirmMutation.reset();
    if (resend) setResent(true);
    else setStep(steps.indexOf('code'));
  };

  const confirmCode = async () => {
    try {
      await confirmMutation.mutateAsync({ code });
    } catch {
      setCode('');
      return;
    }
    setVerifiedEmail(codeSentTo);
    setCode('');
    if (step < lastStep) setStep(step + 1);
    else await register();
  };

  const changeEmail = () => {
    confirmMutation.reset();
    setCode('');
    setStep(steps.indexOf('email'));
  };

  // Back skips the code step once the address is verified: its code has been used up.
  const goBack = () => setStep(steps[step - 1] === 'code' && verifiedEmail ? step - 2 : step - 1);

  const register = async () => {
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
        email: verifiedEmail ?? codeSentTo,
        labRulesConfirmed: state.labRulesRequired,
      });
      setImage(undefined);
    } catch (error) {
      if (apiErrorCode(error) === 'lab_rules_changed') {
        // A newer revision became effective while the visitor was filling in the form: load it, ask again.
        setReady(false);
        setRulesViewed(false);
        setRulesChanged(true);
        setStep(steps.indexOf('rules'));
        await queryClient.invalidateQueries({ queryKey: ['visitor-enrollment', 'state'] });
      }
      if (apiErrorCode(error) === 'email_verification_required') {
        // The server lost or never had the verified address: confirm it again.
        setVerifiedEmail(null);
        setEmailProblem('reverify');
        setStep(steps.indexOf('email'));
        mutation.reset();
      }
      /* Other failures are rendered by the notification below. */
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid[current] || pending) return;
    if (current === 'email') {
      if (!emailIsVerified) await sendCode(false);
      else if (steps.indexOf('code') < lastStep) setStep(steps.indexOf('code') + 1);
      else await register();
      return;
    }
    if (current === 'code') {
      await confirmCode();
      return;
    }
    if (step < lastStep) {
      setStep(step + 1);
      return;
    }
    await register();
  };

  const registering =
    step === lastStep || (current === 'email' && emailIsVerified && steps.indexOf('code') === lastStep);
  const primaryLabel =
    current === 'email' && !emailIsVerified
      ? sendMutation.isPending
        ? 'Sending…'
        : 'Send code'
      : current === 'code'
        ? confirmMutation.isPending || mutation.isPending
          ? 'Checking…'
          : step === lastStep
            ? 'Verify and register'
            : 'Verify code'
        : registering
          ? mutation.isPending
            ? 'Submitting…'
            : 'Register and check in'
          : 'Next';

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
      <Form className="visitor-flow__form" noValidate onSubmit={(event) => void submit(event)}>
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
              subtitle="If your email already belongs to an account, check in with it instead. Otherwise review your entries and try again."
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
              </div>
              <ProfilePhotoPicker image={image} sources={sources} required={photoRequired} onChange={setImage} />
            </div>
          )}

          {current === 'email' && (
            <div className="visitor-flow__email">
              <p className="visitor-flow__lead">
                We email you a six-digit code to confirm your address. Next time, you check in with this email and a new
                code — no password or PIN to remember.
              </p>
              <TextInput
                id="visitor-email"
                type="email"
                size="lg"
                labelText="Email"
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                invalid={emailProblem !== undefined}
                invalidText={emailProblem ? emailProblemText[emailProblem] : undefined}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailProblem(undefined);
                }}
              />
              {emailProblem === 'exists' && (
                <Button as={Link} to="/kiosk" kind="tertiary" size="lg" renderIcon={ArrowLeft}>
                  Go to check-in
                </Button>
              )}
              <p className="visitor-flow__note">
                We only use your address to sign you in and to contact you about your account. Details in the{' '}
                <LegalDocumentLink kind="privacy" inline size="sm">
                  privacy policy
                </LegalDocumentLink>
                .
              </p>
            </div>
          )}

          {current === 'code' && (
            <div className="visitor-flow__email">
              <p className="visitor-flow__lead">
                We sent a six-digit code to <strong>{codeSentTo}</strong>. It is valid for ten minutes.
              </p>
              <TextInput
                id="visitor-code"
                ref={codeInput}
                size="lg"
                className="visitor-flow__code-input"
                labelText="Code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={codeLength}
                autoComplete="one-time-code"
                spellCheck={false}
                invalid={confirmMutation.isError}
                invalidText={
                  apiErrorCode(confirmMutation.error) === 'challenge_invalid'
                    ? 'The code is not correct or has expired. Check it or send a new code.'
                    : "We couldn't check the code. Please try again."
                }
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ''));
                  confirmMutation.reset();
                }}
              />
              {resent && <p className="visitor-flow__note">We sent you a new code.</p>}
              <div className="visitor-flow__code-actions">
                <Button type="button" kind="ghost" size="lg" disabled={pending} onClick={() => void sendCode(true)}>
                  Resend code
                </Button>
                <Button type="button" kind="ghost" size="lg" onClick={changeEmail}>
                  Change email
                </Button>
              </div>
            </div>
          )}

          {current === 'messages' && (
            <div className="visitor-flow__consent">
              <p className="visitor-flow__lead">
                Which messages may we send to {verifiedEmail}? Nothing is preselected, and you can continue with
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
                  <Button
                    type="button"
                    kind="secondary"
                    onClick={() => {
                      setRulesOpen(true);
                      setRulesViewed(true);
                    }}
                  >
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
                  helperText={rulesViewed ? undefined : 'Open the Lab Rules to confirm'}
                  disabled={!rulesViewed}
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
            <Button type="button" kind="secondary" size="xl" renderIcon={ArrowLeft} onClick={goBack}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            size="xl"
            renderIcon={step < lastStep ? ArrowRight : undefined}
            disabled={!valid[current] || pending}
          >
            {primaryLabel}
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
