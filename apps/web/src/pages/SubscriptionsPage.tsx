import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Card, Icon, PageHeader } from '../components/ui';

interface Subscription {
  id: string;
  name: string;
  frequency: string;
  createdAt: string;
}

export default function SubscriptionsPage(): JSX.Element {
  const [rows, setRows] = useState<Subscription[]>([]);

  useEffect(() => {
    api
      .get<{ data: Subscription[]; meta?: { featurePhase?: number } } | Subscription[]>('/subscriptions')
      .then((payload) => {
        const list = Array.isArray(payload) ? payload : payload.data;
        setRows(list);
      })
      .catch(() => setRows([]));
  }, []);

  return (
    <>
      <PageHeader
        title="订阅管理"
        description="订阅规则、推送记录与截止提醒。首版保留数据模型与契约，推送能力在二期开放。"
      />

      <div className="banner warning" style={{ marginBottom: 16 }}>
        <Icon name="clock" size={16} />
        <div>
          <strong>二期开放：</strong>实时推送、每日/每周汇总与截止提醒。首版仅展示已有规则，不会发送消息。
        </div>
      </div>

      <div className="grid-2">
        <Card title="订阅规则" subtitle="首版只读占位">
          {rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Icon name="bell" size={20} />
              </div>
              <div className="empty-title">暂无订阅规则</div>
              <div className="empty-desc">二期可按学科、年级、报名状态配置订阅，并选择实时或定期汇总。</div>
            </div>
          ) : (
            <div className="list">
              {rows.map((row) => (
                <div key={row.id} className="list-row">
                  <div className="stretch">
                    <div className="list-title">{row.name}</div>
                    <div className="list-sub">频率：{row.frequency}</div>
                  </div>
                  <Badge tone="info">待开放</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="推送记录" subtitle="消息投递与关联竞赛明细">
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="file" size={20} />
            </div>
            <div className="empty-title">暂无推送记录</div>
            <div className="empty-desc">
              推送模型已预留批次、渠道、模板版本、投递结果与关联竞赛明细，二期开始写入。
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}