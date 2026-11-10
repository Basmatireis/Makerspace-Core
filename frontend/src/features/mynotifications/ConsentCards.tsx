import { Tile, Toggle } from '@carbon/react';
import { Locked } from '@carbon/icons-react';
import type { NotificationSettings } from '../../api/generated/models';
import { LegalLinks } from '../branding/LegalLinks';
import { useChangeConsent, useChangeFeedbackAtCheckout } from './mutations';

const answerDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "What we may send you": one card per category, then the separate check-out feedback switch. */
export function ConsentCards({ settings }: { settings: NotificationSettings }) {
  const change = useChangeConsent();
  const feedback = useChangeFeedbackAtCheckout();
  const answered = settings.consents
    .map((entry) => entry.answeredAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return (
    <section aria-labelledby="mn-consent-title">
      <div className="mn-section-head">
        <h2 id="mn-consent-title">What we may send you</h2>
        <p>
          {answered ? `Your answer from ${answerDate(answered)}. ` : ''}
          Service &amp; safety is always on; you can still mute single rules below.
        </p>
        <LegalLinks />
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
              ) : (
                <Toggle
                  id={`mn-consent-${entry.categoryId}`}
                  size="sm"
                  aria-label={`Allow ${entry.name}`}
                  hideLabel
                  labelA="Not allowed"
                  labelB="Allowed"
                  toggled={entry.granted === true}
                  onToggle={(granted) => change.mutate({ categoryId: entry.categoryId, granted, name: entry.name })}
                />
              )}
            </div>
            {entry.basis !== 'required' && (
              <p className="mn-card__state" aria-hidden="true">
                {entry.granted === true ? 'Allowed' : 'Not allowed'}
              </p>
            )}
            <p className="mn-card__text">{entry.description}</p>
          </Tile>
        ))}
        <Tile className="mn-card">
          <div className="mn-card__top">
            <h3>Feedback at check-out</h3>
            <Toggle
              id="mn-feedback-at-checkout"
              size="sm"
              aria-label="Ask me at check-out"
              hideLabel
              labelA="Don't ask"
              labelB="Ask me"
              toggled={settings.askFeedbackAtCheckout}
              onToggle={(ask) => feedback.mutate(ask)}
            />
          </div>
          <p className="mn-card__state" aria-hidden="true">
            {settings.askFeedbackAtCheckout ? 'Ask me' : "Don't ask"}
          </p>
          <p className="mn-card__text">
            The tablet may ask you for a minute of feedback when you check out, at most once every few weeks. Separate
            from Surveys &amp; feedback above, because nothing is sent to you.
          </p>
        </Tile>
      </div>
    </section>
  );
}
