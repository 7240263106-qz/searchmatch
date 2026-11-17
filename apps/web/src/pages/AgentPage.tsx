import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentAnswer, AgentActionView } from '@competition/contracts';
import { api } from '../lib/api';
import { Badge, Button, Card, Icon, PageHeader } from '../components/ui';

interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  conditions?: string[];
  actions?: AgentActionView[];
  degraded?: boolean;
  citations?: string[];
}

const EXAMPLES = [
  '找下个月截止的计算机类比赛',
  '有哪些即将截止的创新创业竞赛？',
  '帮我订阅数学建模相关竞赛',
];

export default function AgentPage(): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'agent',
      text: '你好，我是方湖观澜智能体。可以帮你检索竞赛、解释参赛条件、定位报名入口。写操作（发布、删除、合并、订阅）会先征求你的确认。',
    },
  ]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const streamRef = useRef<HTMLDivElement | null>(null);

  const send = async (text: string): Promise<void> => {
    if (!text.trim() || busy) return;
    const userMessage: Message = { id: `u-${Date.now()}`, role: 'user', text };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setBusy(true);
    setError('');
    try {
      const answer = await api.post<AgentAnswer>('/agent/query', { sessionId, message: text });
      setSessionId(answer.sessionId);
      setMessages((current) => [
        ...current,
        {
          id: answer.turnId,
          role: 'agent',
          text: answer.text,
          conditions: answer.conditionsSummary,
          actions: answer.actions,
          degraded: answer.degraded,
          citations: answer.citations?.map((item) => item.snippet).filter(Boolean),
        },
      ]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
      window.setTimeout(() => {
        streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
      }, 60);
    }
  };

  const confirmAction = async (action: AgentActionView): Promise<void> => {
    if (action.type === 'create_competition') {
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ executed: boolean; message: string }>(
        `/agent/actions/${action.actionId}/confirm`,
      );
      setMessages((current) => [
        ...current,
        { id: `r-${Date.now()}`, role: 'agent', text: result.message },
      ]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="对话检索"
        description="用自然语言查询竞赛库、解释参赛条件和定位报名入口；涉及写入的操作需确认。"
        actions={
          <Badge tone="info">
            <Icon name="bot" size={12} /> 只读直答 · 写操作需确认
          </Badge>
        }
      />

      <p className="page-desc" style={{ marginBottom: 16 }}>想查找尚未收录的赛事？<Link className="text-link" to="/collection/web">前往官网采集</Link></p>

      <Card>
        <div className="chat-shell">
          <div className="chat-stream" ref={streamRef}>
            {messages.map((message) => (
              <div key={message.id} className={`msg ${message.role === 'user' ? 'user' : ''}`}>
                <div className="msg-avatar">
                  <Icon name={message.role === 'user' ? 'file' : 'bot'} size={15} />
                </div>
                <div>
                  {message.conditions && message.conditions.length > 0 && (
                    <div className="condition-bar">
                      {message.conditions.map((condition) => (
                        <span key={condition} className="condition">
                          {condition}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="bubble">{message.text}</div>
                  {message.degraded && (
                    <div className="list-sub" style={{ marginTop: 4 }}>
                      <Badge tone="warning">已降级为规则模式</Badge> 解析服务不可用时仍可检索与查看详情。
                    </div>
                  )}
                  {message.citations && message.citations.length > 0 && (
                    <div className="list-sub" style={{ marginTop: 4 }}>
                      引用：{message.citations.slice(0, 2).join(' / ')}
                    </div>
                  )}
                  {message.actions && message.actions.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {message.actions.map((action) =>
                        action.type === 'create_competition' && action.payload.competitionId ? (
                          <Link
                            key={action.actionId}
                            to={`/competitions/${String(action.payload.competitionId)}`}
                            className="btn sm"
                          >
                            {action.label} <Icon name="arrow" size={12} />
                          </Link>
                        ) : (
                          <Button
                            key={action.actionId}
                            size="sm"
                            variant="primary"
                            onClick={() => void confirmAction(action)}
                          >
                            {action.label}
                            {action.requiresConfirmation ? '（需确认）' : ''}
                          </Button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="msg">
                <div className="msg-avatar">
                  <Icon name="bot" size={15} />
                </div>
                <div className="bubble">
                  <span className="muted">正在检索…</span>
                </div>
              </div>
            )}
          </div>

          <div className="chat-input">
            <textarea
              className="textarea"
              rows={2}
              placeholder="例如：找下个月截止的计算机类比赛"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
            />
            <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void send(input)}>
              发送
            </Button>
          </div>
        </div>
      </Card>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="muted">试试：</span>
        {EXAMPLES.map((example) => (
          <button key={example} className="chip" onClick={() => void send(example)}>
            {example}
          </button>
        ))}
      </div>

      {error && <div className="toast">{error}</div>}
    </>
  );
}
