# Architecture

## Boundaries

- `packages/core`: settings, configuration, policy, clocks, randomness and redacted logging.
- `packages/database`: versioned SQLite migrations, repositories and transactional state.
- `packages/assets`: reviewed image manifests, safe paths and byte-hash validation.
- `packages/captcha`: question selection, preprocessing and image composition.
- `packages/i18n`: complete English and Chinese catalogues.
- `apps/bot`: Telegram adapters, intake, verification, Cap HTTP/Mini App, delivery,
  administrator use cases and process lifecycle.

`main.ts` wires these components. Routes translate Telegram updates into use cases;
administrator presentation and moderation live in separate modules. Narrow
repository and Telegram interfaces permit tests without a live bot.

## Verification and delivery

Webhook intake persists updates in SQLite before acknowledging delivery. Polling
uses the same durable inbox. Processing and side effects are separated: a state
transition enqueues outbox work in the same transaction; bounded workers perform
Telegram calls and persist their outcomes. Retries and startup recovery resume
unfinished work. Delivery is at least once, not exactly once: a remote Telegram
success followed by a local commit failure can require reconciliation.

Each join request has its own user/group binding and deadline. Cap validates
Telegram Mini App authentication and binds browser tickets to that request.
Passing Cap grants a separate picture window; skips and retries do not extend it.
Callbacks are opaque, expiring and session-bound. An answer from another account
cannot complete the newcomer's verification. Administrators are authorised again
when privileged actions are applied.

Boards are composed before deployment. Runtime selects from a validated bank,
issues unique per-user callbacks and reuses Telegram file IDs for identical bytes.
A bank fingerprint detects stale asset changes. No runtime image generation or
external AI service is needed in the prepared-board path.

## Concurrency and limits

One Bun process owns one SQLite database. Four outbox workers permit independent
network operations to overlap, while SQLite transactions protect state changes.
Cap concurrency and queue limits bound work; overloaded requests can receive 429
and retry. The ten-user fixture covers concurrent verification, skips, approvals
and cross-user isolation. Real Telegram rate limits and network latency still
bound throughput. Do not use PM2 cluster mode or point multiple hosts at one DB.

## Extending

Add policy and pure logic in core/domain modules, storage behind a repository,
and external calls behind an adapter. Register a thin route and cover permissions,
transaction failure and recovery. Keep secret values and production configuration
outside source control. Schema changes need an explicit migration and recovery plan.
