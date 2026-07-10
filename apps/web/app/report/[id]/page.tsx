import { ResearchReport } from "@/components/research-report";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResearchReport taskId={id} />;
}
