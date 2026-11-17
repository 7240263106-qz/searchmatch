import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { AsyncState, Badge, Button, Card, Icon, PageHeader } from '../components/ui';

interface Metric {
  key: string;
  label: string;
  value: number;
  formula: string;
  cycle: string;
}

interface QualityReport {
  asOf: string;
  metrics: Metric[];
  siteStatus: Array<{ key: string; count: number }>;
}

export default function ReportsPage(): JSX.Element {
  const [report, setReport] = useState<QualityReport | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');

  const load = (): void => {
    setStatus('loading');
    api
      .get<QualityReport>('/reports/quality')
      .then((data) => {
        setReport(data);
        setStatus('ready');
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setStatus('error');
      });
  };

  useEffect(load, []);

  return (
    <>
      <PageHeader
        title="质量报告"
        description="解析、审核与报名入口的健康度指标，全部标注计算公式与统计周期。"
        actions={
          <Button onClick={load}>
            <Icon name="refresh" size={14} /> 刷新
          </Button>
        }
      />
      <AsyncState status={status} message={error} onRetry={load}>
        {report && (
          <>
            <div className="grid-2">
              <Card title="指标概览" subtitle={`数据时间 ${formatDate(report.asOf)}`}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>数值</th>
                      <th>口径</th>
                      <th>周期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.metrics.map((metric) => (
                      <tr key={metric.key}>
                        <td>{metric.label}</td>
                        <td className="mono">{metric.value}</td>
                        <td className="muted">{metric.formula}</td>
                        <td>
                          <Badge tone="neutral">{metric.cycle}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card title="报名入口状态" subtitle="最近一次校验结果分布">
                {report.siteStatus.length === 0 ? (
                  <AsyncState status="empty" message="暂无报名入口数据" />
                ) : (
                  <div className="list">
                    {report.siteStatus.map((item) => (
                      <div key={item.key} className="list-row">
                        <span className="stretch mono muted">{item.key}</span>
                        <span className="mono">{item.count}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="banner warning" style={{ marginTop: 14 }}>
                  <Icon name="alert" size={15} />
                  <div>
                    官方站点可能限制程序访问，403 不等于入口失效；判定需结合跳转、内容特征与人工复核。
                  </div>
                </div>
              </Card>
            </div>

            <div className="grid-2" style={{ marginTop: 16 }}>
              <Card title="AI 解析质量目标" subtitle="首版验收阈值，评测集 ≥200 份">
                <div className="list">
                  <div className="list-row">
                    <span className="stretch">关键字段准确率</span>
                    <Badge tone="success">≥ 90%</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">关键字段遗漏率</span>
                    <Badge tone="warning">≤ 5%</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">无依据字段生成率</span>
                    <Badge tone="warning">≤ 1%</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">时间解析错误率</span>
                    <Badge tone="warning">≤ 5%</Badge>
                  </div>
                </div>
              </Card>

              <Card title="去重与安全" subtitle="回归门槛">
                <div className="list">
                  <div className="list-row">
                    <span className="stretch">误合并率</span>
                    <Badge tone="success">≤ 1%</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">漏合并率</span>
                    <Badge tone="warning">≤ 5%</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">SSRF / 文件 / 注入用例</span>
                    <Badge tone="info">全部拒绝或安全降级</Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch">审计链完整性</span>
                    <Badge tone="success">每日校验</Badge>
                  </div>
                </div>
              </Card>
            </div>
          </>
        )}
      </AsyncState>
    </>
  );
}