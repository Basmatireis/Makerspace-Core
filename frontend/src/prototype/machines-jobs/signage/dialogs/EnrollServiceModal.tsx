import { useState } from 'react';
import { Button, CodeSnippet, InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { useSignage } from '../SignageContext';
import type { ServiceKind } from '../types';

const composeFor = (kind: ServiceKind) => `services:
  ${kind === 'printer_connector' ? 'printer-connector' : 'streaming-gateway'}:
    image: ghcr.io/makerspace-core/${kind === 'printer_connector' ? 'printer-connector' : 'streaming-gateway'}:latest
    env_file: .env
    restart: unless-stopped
`;
const envFor = (kind: ServiceKind) => `CORE_URL=https://core.makerspace.example${kind === 'streaming_gateway' ? '\nSTREAM_PUBLIC_HOST=stream.makerspace.example' : ''}`;

/** Add a local service: choose its kind, then see the one-time enrollment secret and the compose bundle. */
export function EnrollServiceModal({ onClose }: { onClose: () => void }) {
  const signage = useSignage();
  const [kind, setKind] = useState<ServiceKind>('printer_connector');
  const [secret, setSecret] = useState<string | null>(null);

  const download = () => {
    const blob = new Blob([composeFor(kind)], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'compose.yaml';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal open size="md" modalHeading="Add local service" modalLabel="Local services" primaryButtonText={secret ? 'Done' : 'Create enrollment secret'} secondaryButtonText={secret ? undefined : 'Cancel'} preventCloseOnClickOutside
      onRequestClose={onClose} onRequestSubmit={() => { if (secret) onClose(); else setSecret(signage.enrollService(kind)); }}>
      <Stack gap={5}>
        {!secret ? (
          <RadioButtonGroup legendText="Service" name="enroll-kind" orientation="vertical" valueSelected={kind} onChange={(value) => setKind(value as ServiceKind)}>
            <RadioButton id="enroll-connector" value="printer_connector" labelText="Printer connector — talks to the printers in your network" />
            <RadioButton id="enroll-gateway" value="streaming_gateway" labelText="Streaming gateway — turns camera streams into live views" />
          </RadioButtonGroup>
        ) : (
          <>
            <InlineNotification kind="warning" lowContrast hideCloseButton title="Shown once" subtitle="Valid for 15 minutes. Copy it now; Core only keeps a digest." />
            <CodeSnippet type="single" feedback="Copied" aria-label="Enrollment secret">{secret}</CodeSnippet>
            <div><Button kind="tertiary" renderIcon={Download} onClick={download}>Download compose bundle</Button></div>
            <div className="mj-stack">
              <span className="mj-secondary">Add these values to the .env file next to the compose file.</span>
              <CodeSnippet type="multi" feedback="Copied" aria-label=".env snippet">{envFor(kind)}</CodeSnippet>
            </div>
          </>
        )}
      </Stack>
    </Modal>
  );
}
