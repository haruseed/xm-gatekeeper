import { isDatabaseError } from '@guard/database';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY, LANGUAGE_OPTIONS, errorCode, log, sha256Hex, shuffled, tokenHash, type Clock, type Locale, type Rng } from '@guard/core';
import type { AssetStore } from '@guard/assets';
import { LETTERS, type Question } from '@guard/captcha';
import type { RequestRow, Store } from '@guard/database';
import { isKey, t } from '@guard/i18n';
import { BoardProviderBusy, type BoardProvider } from './board-provider';
import { CachedPhotoSender } from './photo-sender';
import { DeferredWork as Defer } from './outbox-dispatcher';
import type { Button, Markup, Tg } from './telegram';

/** Only the persistence operations used by round delivery, not the whole Store API. */
export type ChallengeDeliveryRepository = Pick<Store,
  'getSession' | 'getRequest' | 'getPrefs' | 'requireCap' | 'capPassed' |
  'activateRound' | 'reissueTokens' | 'toReview' | 'setSessionMessage' |
  'cacheGet' | 'cachePut' | 'cacheRemove'>;

interface Presentation {
  groupLabel(chatId: number): string;
  dropPrompt(request: RequestRow): Promise<void>;
  groupNotice(request: RequestRow, key: 'group.review', retry: boolean): Promise<void>;
  say(chatId: number, text: string): Promise<boolean>;
}
interface DeliveryDeps {
  store: ChallengeDeliveryRepository;
  tg: Pick<Tg, 'botId' | 'sendPhoto' | 'deleteMessage'>;
  assets: Pick<AssetStore, 'item'>;
  boards: BoardProvider;
  config: { boardTempDir: string };
  clock: Clock;
  rng: Rng;
  presentation: Presentation;
}

/** Prepare, persist and send a round. Admission and answer decisions stay in Verification. */
export class ChallengeDelivery {
  private readonly photos: CachedPhotoSender;
  constructor(private readonly d: DeliveryDeps) {
    this.photos = new CachedPhotoSender(d.store, d.tg, d.clock);
    mkdirSync(d.config.boardTempDir, { recursive: true, mode: 0o700 });
  }

  private boardPath(hash: string): string {
    return join(this.d.config.boardTempDir, `${hash}.png`);
  }
  private questionText(locale: Locale, q: Question): string {
    if (q.kind === 'function') {
      const key = `fn.${q.itemId}`;
      if (isKey(key)) return t(locale, key);
    }
    const item = this.d.assets.item(q.itemId);
    return t(locale, 'challenge.identify', { item: item?.labels[locale] ?? q.itemId });
  }

  /**
   * Sends the current round. A preparing session gets a fresh board; an active one is re-sent
   * with a new token set (same board and answer). The round is persisted before it is sent.
   */
  async deliver(sessionId: string, chatOverride?: number): Promise<void> {
    const { store, rng, clock } = this.d;
    let s = store.getSession(sessionId);
    if (!s || (s.state !== 'preparing' && s.state !== 'active')) return;
    const r = store.getRequest(s.request_id);
    if (!r || r.state !== 'challenging') return;
    const inGroup = r.kind === 'member';
    const target = inGroup ? r.chat_id : (chatOverride ?? this.d.store.getPrefs(r.user_id)?.explicit_dm_chat_id ?? r.contact_chat_id);
    const replaced = inGroup ? s.message_id : null; // an earlier copy of this round in the group
    if ((store.requireCap && !store.capPassed(r.id))) return;
    const capPassed = store.capPassed(r.id);
    if (capPassed && r.prompt_message_id != null) await this.d.presentation.dropPrompt(r);
    const tokens = Array.from({ length: POLICY.choices }, () => rng.token());
    const hashes = tokens.map(tokenHash);
    let png: Uint8Array;
    let question: Question;
    try {
      if (s.state === 'preparing') {
        const excluded = JSON.parse(s.used_items_json) as string[];
        const board = await this.d.boards.create(rng, excluded);
        const round = board.round;
        png = board.bytes;
        const hash = sha256Hex(png);
        writeFileSync(this.boardPath(hash), png, { mode: 0o600 });
        question = round.question;
        const ok = store.activateRound({
          sessionId: s.id,
          roundNo: s.round_no,
          answerPosition: round.answerPosition,
          answerItem: round.question.itemId,
          boardHash: hash,
          questionJson: JSON.stringify(question),
          tokenHashes: hashes,
          now: clock.now(),
        });
        if (!ok) return;
        s = store.getSession(s.id)!;
      } else {
        png = new Uint8Array(readFileSync(this.boardPath(s.board_hash!)));
        question = JSON.parse(s.question_json!) as Question;
        const next = store.reissueTokens(s.id, hashes, clock.now());
        if (!next) return;
        s = next;
      }
    } catch (e) {
      if (isDatabaseError(e)) throw e;
      if (e instanceof BoardProviderBusy) throw new Defer(e.delayMs);
      if (e instanceof Defer) throw e;
      // Rendering, asset or storage failure: never approve; hand the request to a person.
      log('error', 'round_failed', { error: errorCode(e) });
      store.toReview(r.id, null, 'render_failed', clock.now());
      if (inGroup) await this.d.presentation.groupNotice(r, 'group.review', false);
      else await this.d.presentation.say(target, t(s.locale, 'challenge.review'));
      return;
    }
    const caption = t(s.locale, 'challenge.caption', {
      round: s.round_no,
      total: capPassed ? 1 : POLICY.rounds,
      group: this.d.presentation.groupLabel(r.chat_id),
      question: this.questionText(s.locale, question),
    });
    const order = shuffled(Array.from({length: tokens.length}, (_, i) => i), rng);
    const buttons = order.map((pos) => ({ text: LETTERS[pos]!, callback_data: `c:${tokens[pos]!}` }));
    const languages: Button[] = LANGUAGE_OPTIONS.map(({ locale, label }) => ({
      text: label, callback_data: `l:${locale}`,
    }));
    const markup: Markup = {
      inline_keyboard: [
        buttons.slice(0, 3),
        ...(buttons.length > 3 ? [buttons.slice(3, 6)] : []),
        [{ text: t(s.locale, 'btn.skip'), callback_data: `s:${tokens[0]!}` }],
        languages,
        [{ text: t(s.locale, 'btn.help'), callback_data: `h:${r.id}` }],
      ],
    };
    const messageId = await this.photos.send(target, png, caption, markup, inGroup ? r.user_id : undefined);
    store.setSessionMessage(s.id, s.round_version, messageId);
    if (replaced !== null) await this.d.tg.deleteMessage(r.chat_id, replaced).catch(() => undefined);
  }

  purge(now: number): void {
    try {
      for (const name of readdirSync(this.d.config.boardTempDir)) {
        if (!/^[0-9a-f]{64}\.png$/.test(name)) continue;
        const p = join(this.d.config.boardTempDir, name);
        if (now - statSync(p).mtimeMs > 86_400_000) unlinkSync(p);
      }
    } catch (e) {
      log('warn', 'board_purge_failed', { error: errorCode(e) });
    }
  }
}
