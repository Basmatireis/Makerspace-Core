import {
  Button,
  Checkbox,
  Form,
  InlineNotification,
  Modal,
  PasswordInput,
  ProgressIndicator,
  ProgressStep,
  RadioTile,
  TextInput,
  TileGroup,
} from '@carbon/react';
import { ArrowLeft, ArrowRight } from '@carbon/icons-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  submitVisitorEnrollment,
  type getVisitorEnrollmentState,
} from '../../api/generated/visitor-enrollment/visitor-enrollment';
import type { VisitorAuthenticationMethod } from '../../api/generated/models';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { BrandMark } from '../../app/BrandMark';
import { usePageTitle, useBranding } from '../branding/branding';
import { EnrollmentDone, type EnrollmentOutcome } from './components/EnrollmentDone';
import { LabRulesModal } from './components/LabRulesModal';
import { ProfilePhotoPicker, type ProfileImage } from './components/ProfilePhotoPicker';
import { useInactivityPrompt } from './useInactivityPrompt';
import './visitor.scss';

const idleSeconds = 30;
const graceSeconds = 30;
const stepTitles = ['About you', 'Sign-in method', 'Lab Rules'] as const;
const pinPattern = /^[0-9]{6,12}$/;
const loginNamePattern = /^[A-Za-z0-9._-]{3,64}$/;
const emailPattern = /^\S+@\S+\.\S+$/;

type EnrollmentState = Awaited<ReturnType<typeof getVisitorEnrollmentState>>;

// Three steps that fit one tablet screen. All entries live only in this component: leaving the page (back, Done or
// inactivity) unmounts it, which releases the camera and discards everything.
function BrandLockup() {
  const branding = useBranding();
  return (
    <p className="visitor-flow__brand">
      <BrandMark kind="logo" className="visitor-flow__logo" />
      <span>{branding.identity.displayName}</span>
    </p>
  );
}

export function VisitorWizard({ state }: { state: EnrollmentState }) {
  usePageTitle('Visitor enrollment');
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [image, setImage] = useState<ProfileImage>();
  const [chosen, setChosen] = useState<VisitorAuthenticationMethod>();
  const [loginName, setLoginName] = useState('');
  const [pin, setPIN] = useState('');
  const [ready, setReady] = useState(false);
  const [outcome, setOutcome] = useState<EnrollmentOutcome>();
  const mutation = useSecretMutation(submitVisitorEnrollment, { gcTime: 0 });

  const toTerminal = () => void navigate('/terminal', { replace: true });
  const inactivity = useInactivityPrompt({
    idleSeconds,
    graceSeconds,
    enabled: !outcome,
    onTimeout: toTerminal,
  });

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const hasEmail = email.trim() !== '';
  const options = (['password', 'pin'] as const).filter((method) => state.allowedMethods.includes(method));
  const selectable = options.filter((method) => method !== 'password' || hasEmail);
  // Derived instead of synchronised: an email removed on step 1 invalidates a password choice, and a single
  // possible method is selected for the visitor.
  const method = chosen && selectable.includes(chosen) ? chosen : selectable.length === 1 ? selectable[0] : undefined;

  const valid = [
    firstName.trim() !== '' &&
      lastName.trim() !== '' &&
      (hasEmail || phone.trim() !== '') &&
      (!hasEmail || emailPattern.test(email.trim())) &&
      Boolean(image),
    method === 'password' || (method === 'pin' && loginNamePattern.test(loginName.trim()) && pinPattern.test(pin)),
    ready && Boolean(state.currentLabRules),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid[step] || mutation.isPending) return;
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    if (!image || !method) return;
    try {
      const result = await mutation.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        authMethods: [method],
        pinLoginName: method === 'pin' ? loginName.trim() : null,
        pin: method === 'pin' ? pin : null,
        profileImageBase64: image.base64,
        profileImageFilename: image.filename,
        requestConfirmation: ready,
      });
      setOutcome({
        firstName: firstName.trim(),
        admission: result.admission,
        attendance: result.attendance,
        invitationDelivery: result.invitationDelivery,
        method,
        email: email.trim(),
        loginName: loginName.trim(),
      });
      setPIN('');
      setImage(undefined);
    } catch {
      /* The notification below renders the failure. */
    }
  };

  if (outcome)
    return (
      <main className="visitor-flow">
        <header className="visitor-flow__header visitor-flow__header--done">
          <BrandLockup />
        </header>
        <EnrollmentDone outcome={outcome} onDone={toTerminal} />
      </main>
    );

  return (
    <main className="visitor-flow">
      <Form className="visitor-flow__form" onSubmit={submit}>
        <header className="visitor-flow__header">
          <Button as={Link} to="/terminal" kind="ghost" size="lg" renderIcon={ArrowLeft}>
            Back to check-in
          </Button>
          <BrandLockup />
        </header>

        <ProgressIndicator currentIndex={step} spaceEqually aria-label="Enrollment progress">
          {stepTitles.map((title) => (
            <ProgressStep key={title} label={title} />
          ))}
        </ProgressIndicator>

        <div className="visitor-flow__body">
          <p className="visitor-flow__eyebrow">
            Visitor enrollment · Step {step + 1} of {stepTitles.length}
          </p>
          <h1 className="visitor-flow__title" tabIndex={-1} ref={heading}>
            {stepTitles[step]}
          </h1>

          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Enrollment not completed"
              subtitle="If the login name or email already belongs to an account, check in with it instead. Otherwise review your entries and try again."
            />
          )}

          {step === 0 && (
            <div className="visitor-flow__about">
              <div className="visitor-flow__fields">
                <p className="visitor-flow__note">Fields marked with * are required.</p>
                <div className="visitor-flow__pair">
                  <div className="visitor-required">
                    <TextInput
                      id="visitor-first-name"
                      labelText="First name"
                      required
                      autoComplete="off"
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                    />
                  </div>
                  <div className="visitor-required">
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
                <fieldset className="visitor-flow__contact">
                  <legend className="cds--label">How can we reach you? Email or phone, at least one *</legend>
                  <TextInput
                    id="visitor-email"
                    type="email"
                    labelText="Email"
                    helperText="Needed for an email invitation."
                    autoComplete="off"
                    invalid={hasEmail && !emailPattern.test(email.trim())}
                    invalidText="Enter a valid email address."
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <TextInput
                    id="visitor-phone"
                    type="tel"
                    labelText="Phone"
                    autoComplete="off"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </fieldset>
              </div>
              <ProfilePhotoPicker image={image} onChange={setImage} />
            </div>
          )}

          {step === 1 && (
            <div className="visitor-flow__methods">
              {options.length === 0 ? (
                <InlineNotification
                  kind="warning"
                  lowContrast
                  hideCloseButton
                  title="No sign-in method available"
                  subtitle="Visitor enrollment is not configured with a sign-in method. Ask a staff member."
                />
              ) : (
                <TileGroup
                  legend="How do you want to sign in?"
                  name="visitor-method"
                  valueSelected={method}
                  onChange={(value: string | number | undefined) => setChosen(value as VisitorAuthenticationMethod)}
                >
                  {options.map((option) => (
                    <RadioTile
                      key={option}
                      id={`visitor-method-${option}`}
                      value={option}
                      disabled={!selectable.includes(option)}
                    >
                      <span className="visitor-flow__tile-title">
                        {option === 'password' ? 'Email invitation' : 'Login name and PIN'}
                      </span>
                      <span className="visitor-flow__tile-text">
                        {option === 'password'
                          ? selectable.includes(option)
                            ? 'We email you a link to choose a password.'
                            : 'Not available: you did not enter an email address. Go back to add one.'
                          : 'Choose a login name and a PIN of 6 to 12 digits.'}
                      </span>
                    </RadioTile>
                  ))}
                </TileGroup>
              )}
              {method === 'pin' && (
                <div className="visitor-flow__pair">
                  <div className="visitor-required">
                    <TextInput
                      id="visitor-login-name"
                      labelText="PIN login username"
                      helperText="3–64 letters, numbers, dots, underscores or hyphens."
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      value={loginName}
                      onChange={(event) => setLoginName(event.target.value)}
                    />
                  </div>
                  <div className="visitor-required">
                    <PasswordInput
                      id="visitor-pin-value"
                      labelText="PIN (6–12 digits)"
                      helperText="Digits only."
                      required
                      pattern="[0-9]{6,12}"
                      inputMode="numeric"
                      autoComplete="new-password"
                      value={pin}
                      onChange={(event) => setPIN(event.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 &&
            (state.currentLabRules ? (
              <div className="visitor-flow__rules">
                <p className="visitor-flow__lead">
                  Read the current Lab Rules (revision {state.currentLabRules.humanRevision}). After you submit, a
                  supervisor has you sign the paper version before you may use machines.
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
                  labelText="I am ready to sign the physical Lab Rules document and request supervisor confirmation *"
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
            renderIcon={step < 2 ? ArrowRight : undefined}
            disabled={!valid[step] || mutation.isPending}
          >
            {step < 2 ? 'Next' : mutation.isPending ? 'Submitting…' : 'Submit enrollment'}
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
        onSecondarySubmit={toTerminal}
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
