import { PreparedBoardProvider } from './board-provider';
import { BoardBank } from './board-bank';
import { join } from 'node:path';
import { capHandler } from './cap';
import { Bot } from 'grammy';
import { mkdirSync } from 'node:fs';
import { errorCode, loadConfig, log, secureRng, setLogLevel, systemClock } from '@guard/core';
import { LocalAssetStore } from '@guard/assets';
import { Store, acquireInstanceLock, openDatabase, schemaIsCurrent } from '@guard/database';
import { Admin, Authority } from './admin';
import { ApplicationLifecycle, installShutdown, runScheduler } from './lifecycle';
import { ALLOWED_UPDATES, Poller } from './polling';
import { startWebhookServer } from './webhook';
import { registerRoutes } from './routes';
import { GrammyTg, telegramSignal } from './telegram';
import { synchronizeMenus } from './menu-sync';
import { Verification } from './verification';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  setLogLevel(config.logLevel);
  mkdirSync(config.boardTempDir, { recursive: true, mode: 0o700 });
  let lock: ReturnType<typeof acquireInstanceLock> | undefined;
  let db: ReturnType<typeof openDatabase> | undefined;
  let server: ReturnType<typeof startWebhookServer> | undefined;
  const lifecycle = new ApplicationLifecycle(
    () => server?.stop(false),
    () => { try { db?.close(); } finally { lock?.close(); } },
  );
  const removeSignals = installShutdown(lifecycle);
  const { signal } = lifecycle;
  const loops: Promise<unknown>[] = [];

  const start = async () => {
    lock = acquireInstanceLock(config.databasePath);
    db = openDatabase(config.databasePath);
    if (!schemaIsCurrent(db)) throw new Error('database schema is not current: stop the bot and run `bun run migrate`');
    const store = new Store(db, secureRng, !!config.cap);
    const assets = new LocalAssetStore(config.assetsDir);
    const bank = new BoardBank(join(config.assetsDir, 'board-bank'), assets);
    const bot = new Bot(config.botToken);
    await bot.init(telegramSignal(signal));
    signal.throwIfAborted();
    if (config.cap) config.cap.groupLaunch = bot.botInfo.has_main_web_app === true;
    const tg = new GrammyTg(bot.api, bot.botInfo.id, bot.botInfo.username);
    const clock = systemClock;
    const startedAt = clock.now();
    const verification = new Verification({ store, tg, assets, boards: new PreparedBoardProvider(bank), config, clock, rng: secureRng });
    const poller = new Poller(bot, store, clock);
    const admin = new Admin(store, tg, new Authority(tg, store, clock), verification, clock, () => ({
      lastPollAt: poller.lastPollAt, startedAt, mode: config.webhook ? 'webhook' : 'polling',
    }));
    registerRoutes(bot, { verification, admin, store, assets, tg, clock });
    store.recoverCapPictures(clock.now());
    store.scheduleExistingReviewNotices(clock.now());

    if (config.webhook) {
      // Listen before registering delivery; keep existing pending updates.
      const cap = config.cap ? capHandler(config, store, verification, clock, undefined, lifecycle) : undefined;
      server = startWebhookServer(poller, config.webhook, cap, lifecycle);
      await bot.api.setWebhook(config.webhook.url, {
        secret_token: config.webhook.secret, allowed_updates: ALLOWED_UPDATES,
        max_connections: 20, drop_pending_updates: false,
      }, telegramSignal(signal));
    } else {
      const hook = await bot.api.getWebhookInfo(telegramSignal(signal));
      if (hook.url) await bot.api.deleteWebhook({ drop_pending_updates: false }, telegramSignal(signal));
    }
    signal.throwIfAborted();
    loops.push(lifecycle.track(runScheduler(verification, poller, signal)));
    if (!config.webhook) loops.push(lifecycle.track(poller.run(signal)));
    store.setState('runtime_ready', JSON.stringify({ pid: process.pid, startedAt }));
    log('info', 'started', {
      bot: bot.botInfo.username, mode: config.webhook ? 'webhook' : 'polling',
      assets: assets.approvedIds().length, preparedBoards: bank.size, release: assets.manifest.release,
    });
    // Menu availability must not block verification intake; access is always checked in handlers.
    lifecycle.track(synchronizeMenus({ api: bot.api, tg, store }, signal)
      .catch(error => log('warn', 'set_commands_failed', { error: errorCode(error) })));
  };

  try {
    await lifecycle.track(start());
    await Promise.all(loops);
  } catch (error) {
    const shuttingDown = signal.aborted;
    await lifecycle.stop();
    if (!shuttingDown) throw error;
  } finally {
    await lifecycle.stop();
    removeSignals();
  }
}

main().catch(error => {
  log('error', 'fatal', { error: errorCode(error) });
  process.exit(1);
});
