import { useState } from 'react';
import { Button, CodeSnippet, ComposedModal, InlineNotification, Modal, ModalBody, ModalFooter, ModalHeader, Stack, Tag, TextInput } from '@carbon/react';
import type { StreamingCamera, StreamingGateway, StreamingGatewayEnrollmentIssue } from '../../api/generated/models';
import { formatDateTime } from '../../app/dateTime';
import { gatewayStatus } from './helpers';

export const GatewayStatusTag = ({ gateway, now }: { gateway: StreamingGateway; now: number }) => {
  const status = gatewayStatus(gateway, now);
  return <Tag type={status.type} size="md">{status.label}</Tag>;
};

export function CameraStatusTag({ camera }: { camera: StreamingCamera }) {
  if (!camera.enabled) return <Tag type="gray" size="md">Disabled</Tag>;
  const type = { live: 'green', idle: 'blue', unavailable: 'red', unknown: 'gray' } as const;
  return <Tag type={type[camera.health]} size="md">{camera.health[0].toUpperCase() + camera.health.slice(1)}</Tag>;
}

export function GatewayFormModal({ gateway, pending, error, onSubmit, onClose }: {
  /** Absent when adding a gateway. */
  gateway?: StreamingGateway;
  pending: boolean;
  error?: string;
  onSubmit: (values: { name: string; publicHost: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(gateway?.name ?? '');
  const [publicHost, setPublicHost] = useState(gateway?.publicHost ?? '');
  const [touched, setTouched] = useState(false);
  const invalid = name.trim() === '' || publicHost.trim() === '';
  const submit = () => { setTouched(true); if (!invalid) onSubmit({ name: name.trim(), publicHost: publicHost.trim() }); };
  return (
    <Modal
      open size="sm" modalLabel="Streaming gateways" modalHeading={gateway ? 'Edit gateway' : 'Add gateway'} primaryButtonText={pending ? 'Saving…' : gateway ? 'Save' : 'Add gateway'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={submit}
    >
      <form noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Stack gap={5}>
          <TextInput id="gw-name" labelText="Name" placeholder="e.g. Print room gateway" maxLength={120} value={name} invalid={touched && name.trim() === ''} invalidText="Give the gateway a name" onChange={(event) => setName(event.target.value)} />
          <TextInput
            id="gw-host" labelText="Public host" placeholder="signage-gw.example.org:8443" maxLength={260} value={publicHost} invalid={touched && publicHost.trim() === ''} invalidText="Enter the host name the displays use"
            helperText="hostname[:port] the displays use to reach the gateway over HTTPS. It must match the TLS certificate and STREAM_PUBLIC_HOST." onChange={(event) => setPublicHost(event.target.value)}
          />
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Gateway not saved" subtitle={error} />}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** The one-time enrollment secret with what the administrator does next. Closing it forgets the secret. */
export function EnrollmentSecretModal({ gateway, issue, onClose }: { gateway: StreamingGateway; issue: StreamingGatewayEnrollmentIssue; onClose: () => void }) {
  const env = `MAKERSPACE_VERSION=<release you run>\nCORE_URL=${window.location.origin}\nSTREAM_PUBLIC_HOST=${gateway.publicHost}\nSTREAM_LAN_ADDRESS=<fixed LAN address of the Docker host>`;
  const commands = [
    'cd local-services',
    'cp .env.example .env            # then enter the values above',
    'mkdir -p secrets && chmod 700 secrets',
    "printf '%s' '<enrollment secret from above>' > secrets/streaming-gateway-enrollment",
    'cp fullchain.pem secrets/streaming-gateway-tls.crt && cp privkey.pem secrets/streaming-gateway-tls.key',
    'sudo chown 10001:10001 secrets/streaming-gateway-* && chmod 600 secrets/streaming-gateway-*',
    'docker compose up -d',
  ].join('\n');
  return (
    <ComposedModal open size="md" preventCloseOnClickOutside onClose={onClose}>
      <ModalHeader title={`Enroll ${gateway.name}`} label="Streaming gateways" />
      <ModalBody>
        <Stack gap={5}>
          <InlineNotification kind="warning" lowContrast hideCloseButton title="Shown once, valid 15 minutes." subtitle={`Copy the enrollment secret now; it expires at ${formatDateTime(issue.expiresAt)} and cannot be shown again.`} />
          <CodeSnippet type="multi" aria-label="Enrollment secret">{issue.enrollmentSecret}</CodeSnippet>
          <div>
            <h3>Set up the gateway</h3>
            <p>Use the bundle in <code>local-services/</code> (compose.yaml and .env.example) from the Makerspace Core repository or release, on the Docker host in the makerspace network. Details: docs/streaming-gateway.md.</p>
          </div>
          <CodeSnippet type="multi" aria-label=".env values">{env}</CodeSnippet>
          <CodeSnippet type="multi" aria-label="Docker Compose commands">{commands}</CodeSnippet>
          <p>The printers must be in LAN mode with the camera enabled and have an active Bambu assignment. After the gateway has connected, assign cameras on its detail page.</p>
        </Stack>
      </ModalBody>
      <ModalFooter><Button kind="primary" onClick={onClose}>I have stored the secret</Button></ModalFooter>
    </ComposedModal>
  );
}
