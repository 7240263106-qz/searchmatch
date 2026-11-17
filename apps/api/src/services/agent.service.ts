import { Injectable } from '@nestjs/common';
import type { AgentAnswer, AgentActionView, EvidenceView, SearchQuery } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { CompetitionService } from './competition.service';
import { ParserClient } from './parser-client.service';

const CATEGORY_HINTS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /计算机|编程|算法|软件|人工智能|AI/i, category: '计算机与软件' },
  { pattern: /数学|建模/i, category: '数学与统计' },
  { pattern: /电子|通信|机器人|嵌入式/i, category: '电子信息' },
  { pattern: /物理|力学/i, category: '物理与力学' },
  { pattern: /化学|生物|医学/i, category: '化学与生物' },
  { pattern: /机械|制造|工程训练/i, category: '机械与制造' },
  { pattern: /创业|创新|互联网\+|挑战杯/i, category: '创新创业' },
  { pattern: /设计|艺术|摄影/i, category: '设计与艺术' },
  { pattern: /英语|外语|翻译/i, category: '外语与人文' },
];

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly competitions: CompetitionService,
    private readonly parser: ParserClient,
  ) {}

  async query(
    sessionId: string | undefined,
    message: string,
    actorId: string,
  ): Promise<AgentAnswer> {
    if (!message?.trim()) throw new AppException('INTENT_UNCLEAR');

    const session = sessionId
      ? await this.prisma.agentSession.findFirst({ where: { id: sessionId, ownerId: actorId } })
      : await this.prisma.agentSession.create({ data: { ownerId: actorId } });
    if (!session) throw new AppException('RESOURCE_NOT_FOUND');

    const writeIntent = this.detectWriteIntent(message);
    if (writeIntent) {
      const turn = await this.prisma.agentTurn.create({
        data: {
          sessionId: session.id,
          ownerId: actorId,
          rawIntent: message,
          conclusionType: 'clarification',
          answerText: `我理解你想${writeIntent.label}。该操作属于写入操作，需要你确认后才会执行。`,
          actionJson: JSON.stringify(writeIntent),
        },
      });
      await this.audit.record({
        actorId,
        action: 'agent.write_intent',
        objectType: 'agent_turn',
        objectId: turn.id,
        detail: { type: writeIntent.type },
      });
      return {
        sessionId: session.id,
        turnId: turn.id,
        conclusionType: 'clarification',
        text: `我理解你想${writeIntent.label}。该操作属于写入操作，需要你确认后才会执行。`,
        conditions: null,
        conditionsSummary: [],
        citations: [],
        actions: [
          {
            actionId: turn.id,
            type: writeIntent.type as AgentActionView['type'],
            label: writeIntent.label,
            requiresConfirmation: true,
            payload: writeIntent.payload,
          },
        ],
      };
    }

    const parsed = this.parseConditions(message);
    const result = await this.competitions.search(parsed.query, actorId);
    const top = result.items.slice(0, 3);
    const text =
      result.items.length > 0
        ? `找到 ${result.page.total} 条符合条件的竞赛${top.length ? `，例如：${top.map((item) => item.name).join('、')}` : ''}。`
        : '没有找到符合条件的竞赛。建议减少筛选条件或扩大时间范围。';

    const actions: AgentActionView[] = result.items.slice(0, 1).map((item) => ({
      actionId: `${session.id}-${item.id}`,
      type: 'create_competition',
      label: '查看竞赛详情',
      requiresConfirmation: false,
      payload: { competitionId: item.id },
    }));

    const turn = await this.prisma.agentTurn.create({
      data: {
        sessionId: session.id,
        ownerId: actorId,
        rawIntent: message,
        parsedConditions: JSON.stringify(parsed.query),
        answerText: text,
        conclusionType: 'result',
        actionJson: JSON.stringify(actions),
      },
    });

    return {
      sessionId: session.id,
      turnId: turn.id,
      conclusionType: 'result',
      text,
      conditions: parsed.query,
      conditionsSummary: parsed.summary,
      citations: [] as EvidenceView[],
      actions,
      degraded: !this.parserConfigured(),
    };
  }

  async confirmAction(actionId: string, actorId: string): Promise<{ executed: boolean; message: string }> {
    const turn = await this.prisma.agentTurn.findFirst({ where: { id: actionId, ownerId: actorId } });
    if (!turn) throw new AppException('RESOURCE_NOT_FOUND');
    const action = turn.actionJson ? (JSON.parse(turn.actionJson) as { type: string; payload: Record<string, unknown> }) : null;
    if (!action) throw new AppException('AGENT_WRITE_NOT_CONFIRMED');

    let message = '操作已确认';
    if (action.type === 'delete') {
      const competitionId = String(action.payload.competitionId ?? '');
      if (competitionId) {
        await this.prisma.competition.update({
          where: { id: competitionId },
          data: { publishStatus: 'unpublished' },
        });
        message = '已将竞赛下架（逻辑删除），历史版本仍保留';
      }
    } else if (action.type === 'publish') {
      const competitionId = String(action.payload.competitionId ?? '');
      if (competitionId) {
        await this.competitions.submitReview(competitionId, actorId, '智能体确认提交');
        await this.competitions.publish(competitionId, actorId, '智能体确认发布');
        message = '已提交审核并发布';
      }
    } else if (action.type === 'subscribe') {
      await this.prisma.subscriptionRule.create({
        data: {
          ownerId: actorId,
          name: String(action.payload.name ?? '智能体创建的订阅'),
          conditionsJson: JSON.stringify(action.payload.conditions ?? {}),
          frequency: 'weekly',
        },
      });
      message = '订阅已创建（首版为只读占位，二期开始推送）';
    } else {
      message = `已记录操作 ${action.type}，该类型将在后续版本开放`;
    }

    await this.prisma.agentTurn.update({
      where: { id: turn.id },
      data: { confirmed: true, executed: true },
    });
    await this.audit.record({
      actorId,
      action: 'agent.action_confirmed',
      objectType: 'agent_turn',
      objectId: turn.id,
      detail: { type: action.type },
    });
    return { executed: true, message };
  }

  async session(sessionId: string, actorId: string): Promise<unknown> {
    const session = await this.prisma.agentSession.findFirst({
      where: { id: sessionId, ownerId: actorId },
      include: { turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new AppException('RESOURCE_NOT_FOUND');
    return {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      turns: session.turns.map((turn) => ({
        id: turn.id,
        rawIntent: turn.rawIntent,
        parsedConditions: turn.parsedConditions ? JSON.parse(turn.parsedConditions) : null,
        answerText: turn.answerText,
        conclusionType: turn.conclusionType,
        degraded: turn.degraded,
        confirmed: turn.confirmed,
        executed: turn.executed,
        createdAt: turn.createdAt.toISOString(),
      })),
    };
  }

  private detectWriteIntent(message: string): { type: string; label: string; payload: Record<string, unknown> } | null {
    if (/(删除|下架|移除)/.test(message)) {
      return { type: 'delete', label: '下架或删除竞赛信息', payload: {} };
    }
    if (/(合并|去重)/.test(message)) {
      return { type: 'merge', label: '合并重复的竞赛信息', payload: {} };
    }
    if (/(发布|上线)/.test(message)) {
      return { type: 'publish', label: '发布竞赛信息', payload: {} };
    }
    if (/(订阅|提醒我|通知我)/.test(message)) {
      return { type: 'subscribe', label: '创建订阅规则', payload: { name: message.slice(0, 40) } };
    }
    return null;
  }

  private parseConditions(message: string): { query: SearchQuery; summary: string[] } {
    const summary: string[] = [];
    const query: SearchQuery = { limit: 20, includeExpired: false };

    const category = CATEGORY_HINTS.find((hint) => hint.pattern.test(message))?.category;
    if (category) {
      query.categories = [category];
      summary.push(`学科：${category}`);
    }

    const keywordMatch = /(?:关于|找|查|搜索|看看|有没有)([^\s，。]{2,12})/.exec(message);
    if (keywordMatch?.[1] && !category) {
      query.keyword = keywordMatch[1];
      summary.push(`关键词：${keywordMatch[1]}`);
    }

    if (/(即将截止|快截止|马上截止)/.test(message)) {
      query.registrationStatus = ['closing_soon'];
      summary.push('报名状态：即将截止');
    } else if (/(报名中|还能报名|可以报名)/.test(message)) {
      query.registrationStatus = ['open', 'closing_soon'];
      summary.push('报名状态：报名中');
    } else if (/(未开始|还没开始)/.test(message)) {
      query.registrationStatus = ['not_started'];
      summary.push('报名状态：未开始');
    }

    const now = new Date();
    if (/(下个月|未来30天|未来一个月)/.test(message)) {
      query.deadlineFrom = now.toISOString();
      query.deadlineTo = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      summary.push('截止时间：未来 30 天');
    } else if (/(本周|7天|七天内)/.test(message)) {
      query.deadlineFrom = now.toISOString();
      query.deadlineTo = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      summary.push('截止时间：未来 7 天');
    }

    if (summary.length === 0) {
      summary.push('全部已发布竞赛');
    }
    return { query, summary };
  }

  private parserConfigured(): boolean {
    return this.parser !== undefined;
  }
}