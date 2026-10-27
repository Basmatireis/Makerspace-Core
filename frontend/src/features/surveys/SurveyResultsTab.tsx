import { lazy, Suspense, useState } from 'react';
import {
  Button,
  DatePicker,
  DatePickerInput,
  InlineNotification,
  Pagination,
  Select,
  SelectItem,
  SkeletonText,
  Stack,
  Tag,
  Tile,
} from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { exportSurveyResultsCSV } from '../../api/generated/surveys/surveys';
import type { Survey, SurveyQuestionResult, SurveyResponseSource } from '../../api/generated/models';
import { formatDate, pickerDateToDateOnly } from '../../app/dateTime';
import { usePickerDateRange } from '../../app/usePickerDateRange';
import { saveBlob } from '../configtransfer/helpers';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { surveyOverviewQuery, surveyQuestionResultsQuery, type ResultFilters } from './queries';
import { kindLabels } from './surveyModel';

const SurveyResultChart = lazy(() => import('./SurveyResultChart'));
const textPageSize = 10;

export function SurveyResultsTab({ survey }: { survey: Survey }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState<SurveyResponseSource | ''>('');
  const [linkId, setLinkId] = useState('');
  const range = usePickerDateRange(from, to);
  const overview = useQuery(surveyOverviewQuery(survey.id));
  const filters: ResultFilters = {
    from: from || undefined,
    to: to || undefined,
    source: source || undefined,
    linkId: source !== 'invitation' && linkId ? linkId : undefined,
  };
  const results = useQuery(surveyQuestionResultsQuery(survey.id, filters, textPageSize, 0));
  const exportCsv = useMutation({
    mutationFn: async () => {
      const csv = await exportSurveyResultsCSV(survey.id, filters);
      saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `survey-${survey.id}-results.csv`);
    },
  });
  const links = overview.data?.links ?? [];
  return (
    <Stack gap={6}>
      <QueryBoundary query={overview} errorMessage="The overview could not be loaded.">
        {(data) => (
          <div className="summary-grid survey-overview">
            <Tile>
              <p>Invitations sent</p>
              <strong>{data.invitationsSent}</strong>
            </Tile>
            <Tile>
              <p>Responses</p>
              <strong>{data.responses}</strong>
              <p className="settings-section__description">
                {data.responsesByInvitation} by invitation · {data.responsesByLink} by link
              </p>
            </Tile>
            <Tile>
              <p>Response rate</p>
              <strong>{data.responseRate === null ? '–' : `${Math.round(data.responseRate * 100)} %`}</strong>
              <p className="settings-section__description">Invitations only</p>
            </Tile>
            <Tile>
              <p>First / last response</p>
              <strong>
                {data.firstResponseOn ? formatDate(data.firstResponseOn) : '–'} /{' '}
                {data.lastResponseOn ? formatDate(data.lastResponseOn) : '–'}
              </strong>
            </Tile>
          </div>
        )}
      </QueryBoundary>
      <SettingsSection
        title="Answers"
        actions={
          <Button
            kind="tertiary"
            renderIcon={Download}
            disabled={exportCsv.isPending}
            onClick={() => exportCsv.mutate()}
          >
            Export CSV
          </Button>
        }
      >
        <Stack gap={5}>
          <div className="survey-filters">
            <DatePicker
              datePickerType="range"
              dateFormat="d.m.Y"
              locale="en"
              value={range}
              onChange={(dates) => {
                setFrom(dates[0] ? pickerDateToDateOnly(dates[0]) : '');
                setTo(dates[1] ? pickerDateToDateOnly(dates[1]) : dates[0] ? pickerDateToDateOnly(dates[0]) : '');
              }}
            >
              <DatePickerInput id="survey-filter-from" labelText="From" placeholder="dd.mm.yyyy" />
              <DatePickerInput id="survey-filter-to" labelText="To" placeholder="dd.mm.yyyy" />
            </DatePicker>
            <Select
              id="survey-filter-source"
              labelText="Source"
              value={source}
              onChange={(event) => setSource(event.target.value as SurveyResponseSource | '')}
            >
              <SelectItem value="" text="All sources" />
              <SelectItem value="invitation" text="Invitations" />
              <SelectItem value="link" text="Share links" />
            </Select>
            {source !== 'invitation' && links.length > 0 && (
              <Select
                id="survey-filter-link"
                labelText="Share link"
                value={linkId}
                onChange={(event) => setLinkId(event.target.value)}
              >
                <SelectItem value="" text="All links" />
                {links.map((link) => (
                  <SelectItem key={link.linkId} value={link.linkId} text={link.label ?? 'Unnamed link'} />
                ))}
              </Select>
            )}
            {(from || to || source || linkId) && (
              <Button
                kind="ghost"
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setSource('');
                  setLinkId('');
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
          {exportCsv.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Export failed"
              subtitle={exportCsv.error.message}
            />
          )}
          <QueryBoundary query={results} errorMessage="The results could not be loaded.">
            {(data) =>
              data.totalResponses === 0 ? (
                <p>No responses match these filters.</p>
              ) : (
                <div className="survey-result-list">
                  {data.questions.map((question) => (
                    <QuestionResultCard
                      key={question.questionId}
                      surveyId={survey.id}
                      question={question}
                      filters={filters}
                    />
                  ))}
                </div>
              )
            }
          </QueryBoundary>
        </Stack>
      </SettingsSection>
    </Stack>
  );
}

function chartRows(question: SurveyQuestionResult) {
  if (question.rating)
    return question.rating.distribution.map((bucket) => ({ label: String(bucket.value), value: bucket.count }));
  if (question.yesNo)
    return [
      { label: 'Yes', value: question.yesNo.yes },
      { label: 'No', value: question.yesNo.no },
    ];
  return question.options.map((option) => ({ label: option.label, value: option.count }));
}

function QuestionResultCard({
  surveyId,
  question,
  filters,
}: {
  surveyId: string;
  question: SurveyQuestionResult;
  filters: ResultFilters;
}) {
  const title = `${question.position}. ${question.prompt}`;
  return (
    <Tile className="survey-result-card">
      <div className="survey-question-card__heading">
        <h3>{title}</h3>
        <div className="survey-question-card__tags">
          <Tag size="sm" type="outline">
            {kindLabels[question.kind]}
          </Tag>
          <Tag size="sm" type="gray">
            {question.respondents} {question.respondents === 1 ? 'answer' : 'answers'}
          </Tag>
        </div>
      </div>
      {question.text ? (
        <FreeTextAnswers surveyId={surveyId} question={question} filters={filters} />
      ) : (
        <>
          {question.rating?.mean != null && (
            <p className="survey-result-card__mean">Mean: {question.rating.mean.toFixed(2)}</p>
          )}
          <Suspense fallback={<SkeletonText paragraph lineCount={4} />}>
            <SurveyResultChart title={title} rows={chartRows(question)} valueHeader="Answers" />
          </Suspense>
        </>
      )}
    </Tile>
  );
}

function FreeTextAnswers({
  surveyId,
  question,
  filters,
}: {
  surveyId: string;
  question: SurveyQuestionResult;
  filters: ResultFilters;
}) {
  const [page, setPage] = useState(1);
  const paged = useQuery({
    ...surveyQuestionResultsQuery(surveyId, filters, textPageSize, (page - 1) * textPageSize),
    enabled: page > 1,
  });
  const text =
    (page > 1 ? paged.data?.questions.find((item) => item.questionId === question.questionId)?.text : null) ??
    question.text;
  if (!text || text.total === 0) return <p className="settings-section__description">No written answers.</p>;
  return (
    <Stack gap={4}>
      <ul className="survey-text-answers">
        {text.items.map((answer, index) => (
          <li key={`${page}-${index}`}>
            <span>{answer.text}</span>
            <span className="settings-section__description">{formatDate(answer.submittedOn)}</span>
          </li>
        ))}
      </ul>
      {text.total > textPageSize && (
        <Pagination
          size="sm"
          page={page}
          pageSize={textPageSize}
          pageSizes={[textPageSize]}
          totalItems={text.total}
          onChange={({ page: next }) => setPage(next)}
        />
      )}
    </Stack>
  );
}
