import { Tag, Tile, Toggle } from '@carbon/react';
import { Locked } from '@carbon/icons-react';
import type { NotificationSettings } from '../../api/generated/models';
import { LegalLinks } from '../branding/LegalLinks';
import { useChangeConsent } from './mutations';

const answerDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

type ConsentCardsViewProps = {
  settings: NotificationSettings;
  /** Whose answers these are: the signed-in person ("you") or someone a staff member looks at. */
  subject?: 'you' | 'person';
  /** Without a handler the consent answers are shown, not changed. */
  onConsent?: (change: { categoryId: string; granted: boolean; name: string }) => void;
};

const consentState = (granted: boolean | null) =>
  granted === true ? 'Allowed' : granted === false ? 'Not allowed' : 'Not answered yet';

/** "What we may send you": one card per consent category. */
export function ConsentCardsView({ settings, subject = 'you', onConsent }: ConsentCardsViewProps) {
  const own = subject === 'you';
  const answered = settings.consents
    .map((entry) => entry.answeredAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return (
    <section aria-labelledby="mn-consent-title">
      <div className="mn-section-head">
        <h2 id="mn-consent-title">{own ? 'What we may send you' : 'What we may send'}</h2>
        <p>
          {answered ? `${own ? 'Your' : 'Their'} answer from ${answerDate(answered)}. ` : ''}
          {own
            ? 'Service & safety is always on; you can still mute single rules below.'
            : 'Service & safety is always on. Consent answers can only be changed by the person.'}
        </p>
        {own && <LegalLinks />}
      </div>
      <div className="mn-cards">
        {settings.consents.map((entry) => (
          <Tile key={entry.categoryId} className="mn-card">
            <div className="mn-card__top">
              <h3>{entry.name}</h3>
              {entry.basis === 'required' ? (
                <span className="mn-locked">
                  <Locked size={16} />
                  Always on
                </span>
              ) : onConsent ? (
                <Toggle
                  id={`mn-consent-${entry.categoryId}`}
                  size="sm"
                  aria-label={`Allow ${entry.name}`}
                  hideLabel
                  labelA="Not allowed"
                  labelB="Allowed"
                  toggled={entry.granted === true}
                  onToggle={(granted) => onConsent({ categoryId: entry.categoryId, granted, name: entry.name })}
                />
              ) : (
                <Tag type={entry.granted === true ? 'green' : 'gray'} size="sm">
                  {consentState(entry.granted)}
                </Tag>
              )}
            </div>
            {entry.basis !== 'required' && onConsent && (
              <p className="mn-card__state" aria-hidden="true">
                {entry.granted === true ? 'Allowed' : 'Not allowed'}
              </p>
            )}
            {entry.basis !== 'required' && !onConsent && (
              <p className="mn-card__state">
                {entry.answeredAt ? `Answered ${answerDate(entry.answeredAt)}` : 'Not answered yet'}
              </p>
            )}
            <p className="mn-card__text">{entry.description}</p>
          </Tile>
        ))}
      </div>
    </section>
  );
}

/** The signed-in person's own consents: every change is saved at once. */
export function ConsentCards({ settings }: { settings: NotificationSettings }) {
  const change = useChangeConsent();
  return <ConsentCardsView settings={settings} onConsent={(answer) => change.mutate(answer)} />;
}
