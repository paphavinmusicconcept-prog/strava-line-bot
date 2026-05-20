# Backend Architecture

The bot is now split into production-oriented backend layers while keeping the existing LINE UX intact.

## Runtime Flow

```text
LINE webhook
-> signature verification
-> per-user rate limit
-> event branch
-> service/repository helpers
-> DB persistence
-> LINE reply
```

## Layers

- `index.js`: Express app, webhook orchestration, existing Flex builders.
- `migrations/`: versioned SQL for database shape.
- `src/db/migrations.js`: runtime migration runner for Render/Supabase deploys.
- `src/repositories/`: DB access contracts, starting with activities.
- `src/services/`: cross-request production services such as rate limits.
- `src/utils/`: retry and fingerprint utilities.
- `src/logger.js`: structured logs for production debugging.

## Production Hardening Already Included

- LINE webhook signature verification.
- Token encryption with `TOKEN_ENCRYPTION_KEY`.
- Strava duplicate prevention with source activity IDs.
- GPX duplicate prevention with content fingerprinting.
- SQL migrations and `schema_migrations` tracking.
- Per-minute and per-day usage limits.
- Retry wrapper for LINE, Claude, and Strava calls.
- Structured JSON logging.

## Next 9.5/10 Steps

- Move all Flex builders out of `index.js`.
- Add test runner and unit tests for GPX, PR, signature, rate limits.
- Add BullMQ/Redis for image analysis and memory extraction jobs.
- Add pgvector semantic memory for long-term context search.
