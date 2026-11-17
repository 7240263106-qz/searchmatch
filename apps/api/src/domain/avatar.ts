export type AvatarKind = 'person' | 'document' | 'bot' | 'competition' | 'source';

export function avatarFor(id: string, kind: AvatarKind = 'person'): string {
  return `${kind}:${id}`;
}