# Changelog

## Unreleased

Automatically remove members or reject join requests after delivered checks time
out or exhaust wrong-answer attempts. Keep help requests, raid mode and detected
service problems in manual review. Existing review records are not retroactively
removed. Automatic decisions use the persistent outbox and are recorded in audit.

Automatically remove group review notices after one minute with persistent retries.
Existing tracked review notices are scheduled once on upgrade. Verification and
administrator review decisions are unchanged.

## 0.1.0-alpha.1

First public Alpha release: Telegram member verification, self-hosted Cap and
picture checks, prepared image banks, durable queues, administrator controls and
English/Chinese verification. Includes original demo assets and automated tests.
Interfaces and schema may change before 1.0.
