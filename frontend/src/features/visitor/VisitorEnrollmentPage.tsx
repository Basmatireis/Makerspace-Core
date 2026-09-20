import { Button, Checkbox, FileUploaderDropContainer, Form, InlineNotification, PasswordInput, Stack, TextInput, Tile } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { beginVisitorEnrollment, getVisitorEnrollmentState, submitVisitorEnrollment } from '../../api/generated/visitor-enrollment/visitor-enrollment';
import type { VisitorAuthenticationMethod } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { InlineLoadingState } from '../../app/PageState';

export function VisitorEnrollmentPage() {
  const client = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const nextVisitor = () => {
    client.removeQueries({ queryKey: ['visitor-enrollment'] });
    setAttempt((current) => current + 1);
  };
  const begin = useQuery({
    queryKey: ['visitor-enrollment', 'begin', attempt],
    queryFn: async () => {
      await beginVisitorEnrollment();
      // TanStack Query requires successful query functions to return a defined
      // value. The API deliberately responds with 204 after setting cookies.
      return true;
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const state = useQuery({ queryKey: ['visitor-enrollment', 'state', attempt], queryFn: ({ signal }) => getVisitorEnrollmentState({ signal }), enabled: begin.isSuccess, retry: false, staleTime: Infinity, gcTime: 0 });

  if (begin.isPending || (begin.isSuccess && state.isPending)) return <InlineLoadingState label="Verifying this visitor terminal" />;
  if (begin.isError || state.isError || !state.data) return <main className="public-page"><Stack gap={6}><PageHeader title="Visitor enrollment unavailable" description="This browser is not an enabled visitor terminal. Ask a staff member to verify its ManagedDevice configuration." /></Stack></main>;
  return <main className="public-page"><VisitorForm key={attempt} state={state.data} onNext={nextVisitor} /></main>;
}

function VisitorForm({ state, onNext }: { state: Awaited<ReturnType<typeof getVisitorEnrollmentState>>; onNext: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [methods, setMethods] = useState<VisitorAuthenticationMethod[]>([]);
  const [loginName, setLoginName] = useState('');
  const [pin, setPIN] = useState('');
  const [image, setImage] = useState<{ base64: string; filename: string; preview: string }>();
  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), []);
  const mutation = useSecretMutation(submitVisitorEnrollment, {
    gcTime: 0,
    onSuccess: () => {
      stream.current?.getTracks().forEach((track) => track.stop());
      setFirstName(''); setLastName(''); setEmail(''); setPhone('');
      setLoginName(''); setPIN(''); setImage(undefined); setMethods([]); setReady(false);
    },
  });
  const toggle = (method: VisitorAuthenticationMethod, checked: boolean) => setMethods((current) => checked ? [...new Set([...current, method])] : current.filter((value) => value !== method));
  const loadImage = async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setCameraError('Choose a JPEG, PNG, or WebP image.'); return; }
    if (file.size > 8 * 1024 * 1024) { setCameraError('Choose an image no larger than 8 MiB.'); return; }
    try {
      const dataURL = await fileToDataURL(file);
      setImage({ base64: dataURL.slice(dataURL.indexOf(',') + 1), filename: file.name, preview: dataURL });
      setCameraError('');
    } catch { setCameraError('The photo could not be read. Choose another image.'); }
  };
  const startCamera = async () => {
    try {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      if (video.current) video.current.srcObject = stream.current;
      setCameraError('');
    } catch { setCameraError('Camera access failed. You can upload a photo instead.'); }
  };
  const capture = () => {
    const source = video.current;
    if (!source?.videoWidth) { setCameraError('Start the camera and wait for the preview before capturing.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = source.videoWidth; canvas.height = source.videoHeight;
    canvas.getContext('2d')!.drawImage(source, 0, 0);
    const preview = canvas.toDataURL('image/jpeg', 0.9);
    setImage({ base64: preview.slice(preview.indexOf(',') + 1), filename: 'terminal-capture.jpg', preview });
    stream.current?.getTracks().forEach((track) => track.stop());
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!image) return;
    try {
      await mutation.mutateAsync({ firstName, lastName, email: email || null, phone: phone || null, authMethods: methods, pinLoginName: methods.includes('pin') ? loginName : null, pin: methods.includes('pin') ? pin : null, profileImageBase64: image.base64, profileImageFilename: image.filename, requestConfirmation: ready });
    } catch { /* The notification below renders the failure. */ }
  };
  if (mutation.data) return <Stack gap={7}><PageHeader title="Enrollment submitted" description={mutation.data.admission === 'blocked' ? 'Your Account is ready, but admission remains blocked until a supervisor verifies your physical Lab Rules document.' : 'Your visitor Account has been created.'} /><InlineNotification kind={mutation.data.admission === 'blocked' ? 'warning' : 'success'} lowContrast hideCloseButton title={`Admission: ${mutation.data.admission}`} subtitle={mutation.data.invitationDelivery === 'sent' ? 'Check your email to choose your password.' : mutation.data.invitationDelivery === 'failed' ? 'The password invitation could not be delivered. Ask an administrator to resend it.' : 'You can sign in with your username and PIN.'} /><Button onClick={() => { mutation.reset(); onNext(); }}>Next visitor</Button></Stack>;

  return <Form onSubmit={submit}><Stack gap={7}>
    <PageHeader title="Visitor enrollment" description="Create your Makerspace identity on this verified terminal. Your profile remains the same if your Roles change later." />
    {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Enrollment not completed" subtitle="If the username or email already belongs to an Account, use returning-user login. Otherwise review the form and try again." />}
    <Tile><Stack gap={5}><h2>About you</h2><TextInput id="visitor-first-name" labelText="First name" required value={firstName} onChange={(event) => setFirstName(event.target.value)} /><TextInput id="visitor-last-name" labelText="Last name" required value={lastName} onChange={(event) => setLastName(event.target.value)} /><TextInput id="visitor-email" type="email" labelText="Email" value={email} onChange={(event) => setEmail(event.target.value)} /><TextInput id="visitor-phone" type="tel" labelText="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} /></Stack></Tile>
    <Tile><Stack gap={5}><h2>Profile photo</h2><p>A real profile photo is required for identification. It is resized and metadata is removed by the server.</p><video ref={video} autoPlay muted playsInline className="profile-camera" /><div className="form-actions"><Button type="button" kind="secondary" onClick={() => void startCamera()}>Start camera</Button><Button type="button" kind="tertiary" onClick={capture}>Capture photo</Button></div><FileUploaderDropContainer accept={['image/jpeg', 'image/png', 'image/webp']} labelText="or upload a profile photo" multiple={false} onAddFiles={(_, details) => { const file = details.addedFiles[0]; if (file) void loadImage(file); }} />{cameraError && <InlineNotification kind="error" lowContrast hideCloseButton title="Photo unavailable" subtitle={cameraError} />}{image && <img className="profile-image-preview" src={image.preview} alt="Selected profile" />}</Stack></Tile>
    <Tile><Stack gap={5}><h2>Sign-in method</h2>{state.allowedMethods.includes('password') && <Checkbox id="visitor-password" labelText="Email invitation for a local password" checked={methods.includes('password')} onChange={(_, data) => toggle('password', data.checked)} />}{state.allowedMethods.includes('pin') && <Checkbox id="visitor-pin" labelText="Username and PIN" checked={methods.includes('pin')} onChange={(_, data) => toggle('pin', data.checked)} />}{methods.includes('pin') && <><TextInput id="visitor-login-name" labelText="PIN login username" helperText="3–64 letters, numbers, dots, underscores, or hyphens; compared case-insensitively." value={loginName} required onChange={(event) => setLoginName(event.target.value)} /><PasswordInput id="visitor-pin-value" labelText="PIN (6–12 digits)" value={pin} required pattern="[0-9]{6,12}" inputMode="numeric" autoComplete="new-password" onChange={(event) => setPIN(event.target.value)} /></>}</Stack></Tile>
    <Tile><Stack gap={5}><h2>Lab Rules and admission</h2>{state.currentLabRules ? <><p>Review current revision {state.currentLabRules.humanRevision} before requesting the physical-signature workflow.</p><div><Button as="a" href="/api/v1/visitor-enrollment/lab-rules.pdf" target="_blank" kind="secondary">View current Lab Rules PDF</Button></div><Checkbox id="visitor-ready" labelText="I am ready to sign the physical Lab Rules document and request supervisor confirmation" checked={ready} onChange={(_, data) => setReady(data.checked)} /></> : <InlineNotification kind="warning" lowContrast hideCloseButton title="No current Lab Rules" subtitle="Enrollment cannot complete until an effective version is published." />}</Stack></Tile>
    <Button type="submit" disabled={mutation.isPending || !firstName.trim() || !lastName.trim() || (!email.trim() && !phone.trim()) || methods.length === 0 || (methods.includes('password') && !email.trim()) || (methods.includes('pin') && (!loginName.trim() || !/^[0-9]{6,12}$/.test(pin))) || !image || !ready || !state.currentLabRules}>{mutation.isPending ? 'Submitting…' : 'Submit enrollment and request confirmation'}</Button>
  </Stack></Form>;
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}
