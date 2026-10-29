import { CircleFilled } from '@carbon/icons-react';
import { InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from '@carbon/react';
import type { PrivacyCategory, SubjectRequest, SubjectRequestAssessment } from '../../api/generated/models';
import { RichNotification } from '../../app/RichNotification';
import { categoryName } from './privacy';
import { PrivacyLink } from './privacyNavigation';
import { blockerWords, outcomeWords, plural, totalRecords } from './privacyRequests';
import './privacyRequests.scss';

function Summary({ items }: { items: { value: number; label: string }[] }) {
  return (
    <div className="privacy-summary">
      {items.map((item) => (
        <div key={item.label}>
          <span className="privacy-summary__value">{item.value}</span>
          <span className="privacy-summary__label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Notices({
  assessment,
  erasure,
  categories,
}: {
  assessment: SubjectRequestAssessment;
  erasure: boolean;
  categories: readonly PrivacyCategory[] | undefined;
}) {
  const manual = assessment.categories.filter((category) => category.outcome === 'manual_review').length;
  const clear =
    assessment.blockers.length === 0 &&
    assessment.openHolds === 0 &&
    assessment.uncoveredCategories.length === 0 &&
    manual === 0;
  return (
    <div className="privacy-request__notices">
      {clear && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title={erasure ? 'Nothing blocks the erasure.' : 'Nothing blocks the export.'}
        />
      )}
      {assessment.blockers.map((blocker) => (
        <InlineNotification
          key={blocker}
          kind="warning"
          lowContrast
          hideCloseButton
          title="Blocked"
          subtitle={blockerWords[blocker] ?? blocker}
        />
      ))}
      {assessment.openHolds > 0 && (
        <RichNotification kind="warning" title="On hold">
          {plural(assessment.openHolds, 'open hold applies', 'open holds apply')} here.{' '}
          <PrivacyLink section="holds">See the holds</PrivacyLink>
        </RichNotification>
      )}
      {assessment.uncoveredCategories.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Not covered yet"
          subtitle={`No handler exists for ${assessment.uncoveredCategories
            .map((id) => categoryName(categories, id))
            .join(', ')}. Its data is not part of this request.`}
        />
      )}
      {manual > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Needs a manual look"
          subtitle={`${plural(manual, 'category needs', 'categories need')} an operator to act first.`}
        />
      )}
    </div>
  );
}

/** What is held about the person and what happens to each category, in plain words. */
export function RequestAssessment({
  request,
  assessment,
  title,
  lead,
  categories,
}: {
  request: SubjectRequest;
  assessment: SubjectRequestAssessment;
  title: string;
  lead: string;
  categories: readonly PrivacyCategory[] | undefined;
}) {
  const erasure = request.kind === 'erasure';
  const count = (outcome: string) => assessment.categories.filter((category) => category.outcome === outcome).length;
  const summary = erasure
    ? [
        { value: count('erased'), label: 'categories deleted with the person' },
        { value: count('unlinked'), label: 'kept without the person link' },
        { value: count('retained_legal'), label: 'kept for a legal obligation' },
      ]
    : [
        { value: assessment.categories.length, label: 'categories in the export' },
        { value: totalRecords(assessment), label: 'records' },
        { value: assessment.uncoveredCategories.length, label: 'categories without a handler' },
      ];
  return (
    <Tile className="privacy-request__card">
      <div>
        <h2 className="cds--type-productive-heading-03">{title}</h2>
        <p className="privacy-request__lead">{lead}</p>
      </div>
      <Summary items={summary} />
      <Notices assessment={assessment} erasure={erasure} categories={categories} />
      <div className="privacy-request__table">
        <Table size="sm" aria-label={`${title}: categories`}>
          <TableHead>
            <TableRow>
              <TableHeader>Data category</TableHeader>
              <TableHeader className="privacy-request__num">Records</TableHeader>
              <TableHeader>What happens</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {assessment.categories.map((category) => {
              const contains = categories?.find((entry) => entry.id === category.categoryId)?.contains;
              const outcome = category.outcome;
              return (
                <TableRow key={category.categoryId}>
                  <TableCell>
                    <strong>{category.name}</strong>
                    {contains && <div className="cds--type-helper-text-01">{contains}</div>}
                  </TableCell>
                  <TableCell className="privacy-request__num">{category.records}</TableCell>
                  <TableCell>
                    <span className="privacy-outcome">
                      <CircleFilled
                        size={12}
                        className={`privacy-outcome__dot--${outcome ?? 'none'}`}
                        aria-hidden="true"
                      />
                      {outcome ? outcomeWords[outcome] : 'Included in the export'}
                    </span>
                    {category.note && (
                      <span className="privacy-requests__secondary cds--type-helper-text-01"> · {category.note}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Tile>
  );
}
