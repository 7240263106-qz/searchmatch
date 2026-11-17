import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';
import { ConfigResolverService } from '../config/config-resolver.service';
import { CredentialVault } from '../config/credential-vault.service';
import { ModelRequestError, parseModelJson, requestModelCompletion } from '../config/model-completion';

export type ModelTaskType =
  | 'page_understanding'
  | 'link_discovery'
  | 'body_extraction'
  | 'field_extraction'
  | 'intent_recognition'
  | 'answer_composition';

export interface LlmJsonResult<T = unknown> {
  success: boolean;
  data: T | null;
  degraded: boolean;
  reason: string | null;
  model: string | null;
  raw: string | null;
}

const TASK_MODEL_KEY: Record<ModelTaskType, string> = {
  page_understanding: 'model.taskModel.announcement',
  link_discovery: 'model.taskModel.link',
  body_extraction: 'model.taskModel.detail',
  field_extraction: 'model.taskModel.document',
  intent_recognition: 'model.taskModel.judge',
  answer_composition: 'model.taskModel.judge',
};

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
    private readonly vault: CredentialVault,
  ) {}

  private get secretRef(): string | null {
    return this.resolver.get<string | null>('model.secretRef', null);
  }

  get configured(): boolean {
    return Boolean(
      this.resolver.getBoolean('model.enabled', false) &&
        this.resolver.getString('model.baseUrl', '') &&
        this.resolver.getString('model.model', '') &&
        this.secretRef &&
        this.vault.resolve(this.secretRef),
    );
  }

  async completeJson<T = unknown>(
    taskType: ModelTaskType,
    systemPrompt: string,
    userContent: string,
    related?: { relatedType?: string; relatedId?: string },
  ): Promise<LlmJsonResult<T>> {
    if (!this.configured) {
      return { success: false, data: null, degraded: true, reason: 'not_configured', model: null, raw: null };
    }

    const dailyLimit = this.resolver.getNumber('model.dailyQuota', 500);
    const selectedModel =
      this.resolver.getString(TASK_MODEL_KEY[taskType], '') ||
      this.resolver.getString('model.model', '');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const used = await this.prisma.modelCallRecord.count({
      where: { taskType, createdAt: { gte: today } },
    });
    if (used >= dailyLimit) {
      return {
        success: false,
        data: null,
        degraded: true,
        reason: 'quota_exceeded',
        model: selectedModel,
        raw: null,
      };
    }

    const baseUrl = this.resolver.getString('model.baseUrl', '').replace(/\/$/, '');
    const model = selectedModel;
    const apiKey = this.secretRef ? this.vault.resolve(this.secretRef) : null;
    if (!apiKey) {
      return {
        success: false,
        data: null,
        degraded: true,
        reason: 'credential_missing',
        model,
        raw: null,
      };
    }
    const attemptId = randomUUID();
    const started = Date.now();

    try {
      const { content, usage } = await requestModelCompletion({
        baseUrl,
        model,
        apiKey,
        timeoutMs: this.resolver.getNumber('model.timeoutMs', 30000),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent.slice(0, 12000) },
        ],
      });

      const durationMs = Date.now() - started;
      let parsed: T;
      try {
        parsed = parseModelJson<T>(content);
      } catch {
        await this.record(taskType, model, attemptId, durationMs, false, true, 'invalid_json', related);
        return { success: false, data: null, degraded: true, reason: 'invalid_json', model, raw: content };
      }

      await this.record(
        taskType,
        model,
        attemptId,
        durationMs,
        true,
        false,
        null,
        related,
        usage?.prompt_tokens,
        usage?.completion_tokens,
      );
      return { success: true, data: parsed, degraded: false, reason: null, model, raw: content };
    } catch (error) {
      const durationMs = Date.now() - started;
      const reason = error instanceof ModelRequestError ? error.reason : 'network_error';
      await this.record(taskType, model, attemptId, durationMs, false, true, reason, related);
      this.logger.warn(`llm ${taskType} failed: ${reason}`);
      return { success: false, data: null, degraded: true, reason, model, raw: null };
    }
  }

  private async record(
    taskType: ModelTaskType,
    model: string,
    attemptId: string,
    durationMs: number,
    success: boolean,
    degraded: boolean,
    degradeReason: string | null,
    related?: { relatedType?: string; relatedId?: string },
    inputTokens?: number,
    outputTokens?: number,
  ): Promise<void> {
    await this.prisma.modelCallRecord.create({
      data: {
        taskType,
        model,
        configVersion: this.resolver.snapshotVersion(),
        promptVersion: 'v1',
        attemptId,
        durationMs,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        cost: null,
        costUnknown: true,
        degraded,
        degradeReason,
        success,
        relatedType: related?.relatedType ?? null,
        relatedId: related?.relatedId ?? null,
      },
    });
  }
}
