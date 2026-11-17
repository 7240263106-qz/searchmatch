import { Link } from 'react-router-dom';
import AgentDiscovery from '../components/AgentDiscovery';
import { PageHeader } from '../components/ui';

export default function WebCollectionPage(): JSX.Element {
  return (
    <>
      <PageHeader
        title="官网采集"
        description="输入赛事名称，查找官网与公告，查看提取字段、原文依据和附件。"
        actions={<Link className="btn sm" to="/library/assistant">查询库内竞赛</Link>}
      />
      <AgentDiscovery />
    </>
  );
}
