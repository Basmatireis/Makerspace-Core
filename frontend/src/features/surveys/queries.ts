import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import {
  getSurvey,
  getSurveyQuestionResults,
  getSurveyResultsOverview,
  listSurveyShareLinks,
  listSurveys,
} from '../../api/generated/surveys/surveys';
import type { GetSurveyQuestionResultsParams, ListSurveysParams } from '../../api/generated/models';

export type ResultFilters = Pick<GetSurveyQuestionResultsParams, 'from' | 'to' | 'source' | 'linkId'>;

export const surveyKeys = {
  all: ['surveys'] as const,
  list: (params: ListSurveysParams) => [...surveyKeys.all, 'list', params] as const,
  detail: (id: string) => [...surveyKeys.all, 'detail', id] as const,
  links: (id: string) => [...surveyKeys.all, 'links', id] as const,
  overview: (id: string) => [...surveyKeys.all, 'overview', id] as const,
  questions: (id: string, filters: ResultFilters, textLimit: number, textOffset: number) =>
    [...surveyKeys.all, 'questions', id, filters, textLimit, textOffset] as const,
};

export const surveysQuery = (params: ListSurveysParams) =>
  queryOptions({
    queryKey: surveyKeys.list(params),
    queryFn: ({ signal }) => listSurveys(params, { signal }),
    placeholderData: keepPreviousData,
  });
export const surveyQuery = (id: string) =>
  queryOptions({ queryKey: surveyKeys.detail(id), queryFn: ({ signal }) => getSurvey(id, { signal }) });
/** Reading links needs `surveys.manage`: the tokens are shown again. */
export const surveyLinksQuery = (id: string) =>
  queryOptions({ queryKey: surveyKeys.links(id), queryFn: ({ signal }) => listSurveyShareLinks(id, { signal }) });
/** The overview always covers every response; only the per-question results take filters. */
export const surveyOverviewQuery = (id: string) =>
  queryOptions({
    queryKey: surveyKeys.overview(id),
    queryFn: ({ signal }) => getSurveyResultsOverview(id, { signal }),
  });
export const surveyQuestionResultsQuery = (id: string, filters: ResultFilters, textLimit: number, textOffset: number) =>
  queryOptions({
    queryKey: surveyKeys.questions(id, filters, textLimit, textOffset),
    queryFn: ({ signal }) => getSurveyQuestionResults(id, { ...filters, textLimit, textOffset }, { signal }),
    placeholderData: keepPreviousData,
  });
