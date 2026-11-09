import { Modal, RadioTile, Stack, TileGroup } from '@carbon/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationRule } from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';

const starts = [
  {
    value: 'event',
    label: 'When something happens',
    help: 'A printer error, a check-in, a freed place, a payment, a new sign-in …',
  },
  { value: 'schedule', label: 'On a schedule', help: 'At set times, optionally for each person, open day, order …' },
  {
    value: 'loop',
    label: 'For each person',
    help: 'A personal message to everyone the conditions find, with their own values.',
  },
  { value: 'manual', label: 'By hand', help: 'Runs only when someone presses Run now.' },
] as const;

type Props = { open: boolean; rules: NotificationRule[]; onClose: () => void };

/** Chooses how a new rule starts: from a blank trigger type or as a copy of an existing rule. */
export function NewRuleModal({ open, rules, onClose }: Props) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>('event');
  const [template, setTemplate] = useState<NotificationRule | null>(null);
  // System rules first: they are the examples people most often start from.
  const sorted = [...rules].sort((a, b) => Number(Boolean(b.systemKey)) - Number(Boolean(a.systemKey)));
  return (
    <Modal
      open={open}
      size="md"
      modalHeading="New rule"
      modalLabel="Notification center"
      primaryButtonText={template ? 'Copy rule' : 'Create rule'}
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => {
        if (template) void navigate('/settings/notifications/rules/new', { state: { template } });
        else void navigate(`/settings/notifications/rules/new?type=${kind}`);
      }}
    >
      <Stack gap={6}>
        <TileGroup
          legend="Start with"
          name="new-rule-kind"
          valueSelected={template ? '' : kind}
          onChange={(value) => {
            setTemplate(null);
            setKind(String(value));
          }}
          className="nc-start"
        >
          {starts.map((start) => (
            <RadioTile key={start.value} id={`new-rule-${start.value}`} value={start.value}>
              <strong>{start.label}</strong>
              <span className="nc-appearance__help">{start.help}</span>
            </RadioTile>
          ))}
        </TileGroup>
        <FuzzyComboBox<NotificationRule>
          id="new-rule-template"
          titleText="Or start from an existing rule"
          helperText="Copies its trigger, conditions and messages. The copy starts switched off."
          placeholder="Search rules"
          items={sorted}
          itemToString={(rule) => rule?.name ?? ''}
          selectedItem={template}
          onChange={({ selectedItem }) => setTemplate(selectedItem ?? null)}
        />
      </Stack>
    </Modal>
  );
}
