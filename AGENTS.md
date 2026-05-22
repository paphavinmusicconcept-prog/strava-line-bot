# AGENTS.md

Project context and working rules for Codex agents working on this repository.

## Project Summary

This project is a LINE bot for runners. It connects LINE, Strava/running data, AI coaching responses, PostgreSQL storage, and Render deployment.

Current important features:
- LINE webhook handling in `index.js`.
- Strava token storage and activity fetching.
- Screenshot/GPX running result analysis.
- Rich messages for run results, weekly stats, HR zone display, and weight training.
- Weight Training workflow with DB-backed session state.
- User memory stored in PostgreSQL via `user_memory`.
- Render deployment for the production service.
- LINE Rich Menu currently routes the Weight Training button to `action=weight_training`.

Production service:
- Render service name: `strava-line-bot`
- Render URL: `https://strava-line-bot.onrender.com`
- Health endpoint: `https://strava-line-bot.onrender.com/health`

Do not expose, print, commit, or summarize secret values from Render, LINE, Strava, Anthropic, GitHub, or database environment variables.

## Read First

Before changing code, read:
- `AGENTS.md`
- `package.json`
- Relevant code files for the requested task
- Relevant docs under `docs/` if present
- `README.md` if it exists

If the task is a bug, explain the likely cause before fixing it.

## Project Rules

- Inspect relevant files before editing.
- Do not rewrite the whole project.
- Do not delete existing features unless explicitly asked.
- Do not change unrelated files.
- Make the smallest safe patch.
- Preserve existing behavior unless explicitly asked to change it.
- Prefer existing project patterns over new abstractions.
- Keep changes easy to review.
- After editing, summarize changed files.
- Tell the user how to test the result.

## Code Style

- This is a Node.js/CommonJS project.
- Keep edits close to the existing style in `index.js` and `src/`.
- Avoid broad refactors while fixing small bugs.
- Use clear function names and small helper functions when needed.
- Do not add new dependencies unless the task clearly requires them.
- Avoid logging sensitive tokens, webhook bodies containing secrets, or user-private data.

## LINE Bot Rules

- Verify LINE signature before processing webhook events.
- Preserve existing menu actions unless the task asks to change them.
- Rich Menu action mapping should stay explicit in `normalizeMenuAction`.
- Weight Training should route through `action=weight_training` or equivalent aliases.
- Do not reintroduce the old Recovery/Strength AI shortcut for the Weight Training button.
- If changing Rich Menu behavior, check both:
  - Backend action mapping in code
  - The actual LINE Rich Menu displayText/action through the LINE API or LINE manager

## Weight Training Workflow

Weight Training is intended to be a real step-by-step workflow:
1. Ask focus: legs, core, injury prevention, full body
2. Ask duration: 10, 20, 30 minutes
3. Ask equipment: none, dumbbell, band, gym
4. Send a rich message plan
5. Offer buttons: done, lighter, heavier
6. After done, ask feedback: too light, good, too heavy
7. Save feedback for future personalization

Workflow sessions should be persisted with DB-backed storage, not only in server memory, because Render can restart.

## Running Load And Personalization

Current personalization is intentionally lightweight:
- Use recent running load where available.
- Use latest weight training feedback where available.
- Adjust weight training intensity conservatively.

Do not build a large coaching engine unless explicitly asked. Coaching engine work should be treated as a separate feature.

## Rich Messages

Run result rich messages should include:
- Distance
- Pace
- Duration
- Calories/cadence/elevation where available
- HR zone signal/bar where available or estimated
- Short AI insight

Keep LINE Flex messages within LINE limits and avoid overly long text blocks.

## Database And Security

- Keep Strava tokens encrypted at rest in production.
- `TOKEN_ENCRYPTION_KEY` is required in production.
- Avoid schema changes unless necessary.
- If schema changes are needed, add a migration and preserve existing data.
- Never commit real secrets, tokens, or local `.env` files.

## Testing And Verification

After code changes, run the narrowest useful checks:
- `node --check index.js`
- `npm test`
- Any focused test relevant to the changed workflow

For production-facing changes:
- Verify GitHub has the intended file contents.
- Confirm Render deploy is live.
- Check `https://strava-line-bot.onrender.com/health`.
- For LINE Rich Menu changes, verify the actual rich menu via LINE API or LINE manager.

## Suggested Prompt For Future Tasks

Use this when asking Codex to work on the repo:

```text
Read AGENTS.md, README.md, and relevant docs first.

Task:
[describe the task here]

Rules:
- Inspect relevant files before editing
- Do not rewrite the whole project
- Do not change unrelated files
- Make the smallest safe patch
- Preserve existing behavior unless I explicitly ask to change it
- Explain the cause before fixing if this is a bug
- After editing, summarize changed files
- Tell me how to test the result
```
