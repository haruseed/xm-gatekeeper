# Security

This is Alpha software. Evaluate it in a test group before deployment. A solved
challenge does not establish identity or guarantee protection against automation.
The bundled shape images are development fixtures, not a robust production CAPTCHA.

Keep the bot token, webhook secret, Cap secret, database, backups and logs private.
Use HTTPS and a dedicated unprivileged account. Never commit environment files or
production data. SQLite stores verification state, Telegram user/group IDs, minimal
username mappings for moderation, audit records and delivery metadata; review
retention and privacy obligations for your community before use. Avoid debug
logging in public or shared environments.

For a vulnerability, use GitHub private vulnerability reporting if enabled, or
contact the maintainer at dev@goddag.net. Do not include live tokens, user data or
exploit details in a public issue. Reports should include the version, affected
path and a minimal reproduction with synthetic data.
