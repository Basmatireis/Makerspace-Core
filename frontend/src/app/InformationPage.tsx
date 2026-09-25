import { PageHeader } from './PageHeader';

type InformationPageProps = {
  title: string;
};

export function InformationPage({ title }: InformationPageProps) {
  return <PageHeader title={title} />;
}
