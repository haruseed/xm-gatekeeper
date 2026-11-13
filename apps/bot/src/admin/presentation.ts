import type { GroupRow } from '@guard/database';
import type { Button } from '../telegram';

export const ACTION_TTL_MS = 60 * 60_000;
export const CONFIRM_TTL_MS = 2 * 60_000;

/** Shared UI ports; the facade owns actor-bound token creation and message delivery. */
export interface AdminPresentation {
  say(chatId: number, text: string, rows?: Button[][], rich?: boolean): Promise<boolean>;
  button(actor: number, text: string, payload: Record<string, string | number>, ttl?: number): Button;
  label(group: GroupRow): string;
}
