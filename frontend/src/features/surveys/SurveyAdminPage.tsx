import { Navigate, Route, Routes } from 'react-router-dom';
import { SurveyDetailPage } from './SurveyDetailPage';
import { SurveyEditorPage } from './SurveyEditorPage';
import { SurveyListPage } from './SurveyListPage';

/** Everything below `/settings/surveys` is one lazily loaded unit, so the application entry carries a single route. */
export function SurveyAdminPage() {
  return (
    <Routes>
      <Route index element={<SurveyListPage />} />
      <Route path="new" element={<SurveyEditorPage />} />
      <Route path=":surveyId" element={<SurveyDetailPage />} />
      <Route path=":surveyId/edit" element={<SurveyEditorPage />} />
      <Route path="*" element={<Navigate to="/settings/surveys" replace />} />
    </Routes>
  );
}
