# XM Gatekeeper

**v0.1.0-alpha.1 · Alpha testing**

A self-hosted Telegram bot that verifies new members of Ingress community groups.
Built with TypeScript, Bun, grammY and SQLite. One process; no Redis or PostgreSQL.

This is an early public release. Interfaces, configuration and database schema may
change before 1.0. Test with a separate bot and group before using it in a community.

## What it does

- Mutes new arrivals until verification, or verifies join requests before approval.
- Runs a self-hosted Cap browser check, followed by one six-choice picture question.
- Gives Cap and the picture stage separate one-minute windows by default. Picture
  retries, skips and language changes share the same picture deadline.
- Binds challenges and answers to the intended Telegram user, group and session.
- Uses preprocessed image banks and Telegram file ID caching to avoid rendering
  images on every join. Bounded workers support simultaneous verification sessions.
- Provides administrator setup, review, audit, raid controls and moderation by
  reply, known `@username` or numeric ID. Username lookup is limited to users the
  bot has observed; it is not a Telegram-wide search.
- Offers English, Traditional Chinese and Simplified Chinese verification text;
  administrator settings use English.

Cap uses a Telegram Mini App. With the bot's Main Mini App enabled, a newcomer can
launch from the group. A private-chat fallback is available. Returning to the group
waits until the picture and its message link are ready; Telegram client behaviour
can still require a manual tap. Without Cap, the fallback is two picture rounds.
A passed challenge is friction against abuse, not proof that a person is human.

## Included artwork

This repository includes **original geometric demo images**, not Ingress game
artwork or production logos. The demo images make setup and tests reproducible;
they are intentionally easy and are not recommended for real bot protection.
For an Ingress-specific deployment, supply artwork you are licensed to use and
record its provenance. See [assets/README.md](assets/README.md).

## Quick start

Use Bun **1.4.4** (the tested version), Git and a Linux or macOS machine supported
by Sharp. Linux is recommended for deployment.

```sh
git clone https://github.com/haruseed/xm-gatekeeper.git
cd xm-gatekeeper
bun install --frozen-lockfile
bun run assets:build
bun run boards:build -- assets/board-bank 40
bun run assets:validate
bun run typecheck
bun test
cp .env.example .env
```

Edit `.env`: enter a BotFather token and absolute paths to this checkout's assets,
a private database file and a temporary directory. Create the data and temporary
directories, protect `.env`, then initialise the database and start:

```sh
mkdir -p data tmp
chmod 700 data tmp
chmod 600 .env
bun run migrate
bun start
```

The minimal configuration uses long polling and two picture rounds. To enable Cap
and its one-picture flow, configure HTTPS, webhook and Cap variables together as
shown in [deployment](docs/deployment.md). Never run more than one instance against
the same database. A local instance lock also guards against accidental overlap.

Add the bot to a supergroup with **Ban users** and **Invite users via link** rights.
An authorised administrator can then use `/setup` in private chat to enrol and
enable the group. Test both a direct join and a join request with a second account.

## Commands

Members: `/help`, `/whoami`.

Administrators: `/setup`, `/group`, `/status`, `/review`, `/settings`, `/raid`,
`/audit`, `/ban`, `/mute`, `/unban`.
Pause, resume and removal are available through administrator controls.
Availability depends on the caller's current group permissions. See `/help` and
the setup checklist for usage. Addressed commands such as `/status@YourBot` are
supported. Moderation targets are checked against the selected group.

## Development

See [architecture](docs/architecture.md), [deployment](docs/deployment.md),
[security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
Tests use isolated fixture databases and a scripted Telegram adapter; they do not
contact live Telegram accounts. The suite includes ten-user concurrency and
cross-user token-isolation checks. It does not establish production throughput or
CAPTCHA resistance against an adaptive solver.

Contributions are welcome. Keep changes focused, include relevant tests, and run
`bun run typecheck` and `bun test` after preparing the demo image bank. Never submit
credentials, real user data, production database files or unlicensed artwork.

## Licence

MIT for this repository's code and original demo artwork. Dependencies retain
their own licences. Ingress is owned by Niantic Spatial, Inc.; this is an unofficial
community project and is not affiliated with or endorsed by Niantic Spatial.
