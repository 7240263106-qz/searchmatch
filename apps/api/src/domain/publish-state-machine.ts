import { AppException } from '../platform/app-exception';
import type { PublishStatus } from '@competition/contracts';

export const ALLOWED_TRANSITIONS: Record<PublishStatus, PublishStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['published', 'draft'],
  published: ['unpublished'],
  unpublished: ['pending_review'],
};

export function assertTransition(from: PublishStatus, to: PublishStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new AppException(
      'STATE_TRANSITION_INVALID',
      { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
    );
  }
}

export function nextStatus(current: PublishStatus, action: 'submit' | 'publish' | 'unpublish' | 'restore'): PublishStatus {
  if (action === 'submit') {
    if (current !== 'draft' && current !== 'unpublished') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: current, action });
    }
    return 'pending_review';
  }
  if (action === 'publish') {
    if (current !== 'pending_review') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: current, action });
    }
    return 'published';
  }
  if (action === 'unpublish') {
    if (current !== 'published') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: current, action });
    }
    return 'unpublished';
  }
  if (current !== 'unpublished') {
    throw new AppException('STATE_TRANSITION_INVALID', { from: current, action });
  }
  return 'pending_review';
}

export function canAutoPublish(input: {
  officialSource: boolean;
  completeness: string;
  hasConflict: boolean;
  hasDuplicateDispute: boolean;
  signupMethod: string;
  parseFailed: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.officialSource) return { allowed: false, reason: '非官方白名单来源' };
  if (input.completeness !== 'complete') return { allowed: false, reason: '信息不完整' };
  if (input.hasConflict) return { allowed: false, reason: '存在未解决冲突' };
  if (input.hasDuplicateDispute) return { allowed: false, reason: '存在未解决的重复争议' };
  if (input.signupMethod === 'to_be_announced') {
    return { allowed: false, reason: '报名方式尚未公布' };
  }
  if (input.parseFailed) return { allowed: false, reason: '最近解析校验未通过' };
  return { allowed: true, reason: '官方白名单且字段完整无冲突' };
}