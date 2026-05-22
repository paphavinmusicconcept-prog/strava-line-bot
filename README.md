# Strava Coach LINE Bot

LINE bot for runners that connects running data, Strava, AI coaching, PostgreSQL memory, rich messages, and LINE Rich Menu workflows.

Production:
- Render service: `strava-line-bot`
- - App URL: `https://strava-line-bot.onrender.com`
  - - Health check: `https://strava-line-bot.onrender.com/health`
    - - LINE webhook: `https://strava-line-bot.onrender.com/webhook`
     
      - ## Current Features
     
      - - LINE webhook for text, image, file, follow, and postback events
        - - Strava token storage and activity fetching
          - - Screenshot and GPX running result analysis
            - - Rich message run summaries with distance, pace, duration, calories, cadence, elevation, AI insight, and HR zone bar
              - - Weekly and period stats summaries
                - - DB-backed Weight Training workflow
                  - - Weight training feedback memory for future personalization
                    - - User memory and profile context in PostgreSQL
                      - - Render production deployment
                        - - Codex project instructions in `AGENTS.md`
                         
                          - ## Rich Menu v1
                         
                          - The next rich menu layout uses 4 main areas:
                         
                          - ```text
                            [ Today Coach ]

                            [ Stat ] [ Training Plan ] [ Profile Setting ]
                            ```

                            Recommended image size:

                            ```text
                            2500 x 1686 px
                            ```

                            Bounds:

                            ```text
                            Today Coach:     x 0,    y 0,   w 2500, h 843, action=today_coach
                            Stat:            x 0,    y 843, w 833,  h 843, action=stat
                            Training Plan:   x 833,  y 843, w 834,  h 843, action=training_plan
                            Profile Setting: x 1667, y 843, w 833,  h 843, action=profile_setting
                            ```

                            Quick replies:

                            - `Today Coach`: today training, rest check, run or weight, adjust plan
                            - - `Stat`: today, this week, this month, last 3 months
                              - - `Training Plan`: today's plan, this week's plan, goal status, update goal
                                - - `Profile Setting`: HR Zone setup, view profile, edit Max HR, edit Resting HR
                                 
                                  - See `docs/future-rich-menu-plan.md` for the full plan.
                                 
                                  - ## Weight Training Workflow
                                 
                                  - Weight Training is a guided flow:
                                 
                                  - 1. Choose focus: legs, core, injury prevention, full body
                                    2. 2. Choose duration: 10, 20, 30 minutes
                                       3. 3. Choose equipment: none, dumbbell, band, gym
                                          4. 4. Receive a rich message workout plan
                                             5. 5. Tap done, lighter, or heavier
                                                6. 6. After done, answer feedback: too light, good, too heavy
                                                   7. 7. Feedback is saved for future personalization
                                                     
                                                      8. Workflow session state is stored in the database, not only server memory, so Render restarts are safer.
                                                     
                                                      9. ## Important Files
                                                     
                                                      10. - `AGENTS.md` - project rules and context for Codex across computers
                                                          - - `index.js` - main LINE bot, workflows, rich messages, webhook handling
                                                            - - `package.json` - scripts and dependencies
                                                              - - `tests/workflow-static.test.js` - static workflow coverage
                                                                - - `docs/future-rich-menu-plan.md` - rich menu v1 plan and bounds
                                                                  - - `src/db/migrations.js` - database migrations
                                                                    - - `src/security/tokenCrypto.js` - token encryption
                                                                      - - `src/security/lineSignature.js` - LINE signature validation
                                                                        - - `src/services/lineService.js` - LINE reply/push helpers
                                                                         
                                                                          - ## Environment Variables
                                                                         
                                                                          - Required production variables include:
                                                                         
                                                                          - - `LINE_CHANNEL_ACCESS_TOKEN`
                                                                            - - `LINE_CHANNEL_SECRET`
                                                                              - - `ANTHROPIC_API_KEY`
                                                                                - - `DATABASE_URL`
                                                                                  - - `TOKEN_ENCRYPTION_KEY`
                                                                                   
                                                                                    - Do not commit real secrets. `TOKEN_ENCRYPTION_KEY` is required in production so Strava tokens can be encrypted at rest.
                                                                                   
                                                                                    - ## Local Development
                                                                                   
                                                                                    - Install dependencies:
                                                                                   
                                                                                    - ```bash
                                                                                      npm install
                                                                                      ```

                                                                                      Run locally:

                                                                                      ```bash
                                                                                      npm run dev
                                                                                      ```

                                                                                      Run production command locally:

                                                                                      ```bash
                                                                                      npm start
                                                                                      ```

                                                                                      ## Testing

                                                                                      Syntax check:

                                                                                      ```bash
                                                                                      node --check index.js
                                                                                      ```

                                                                                      Workflow static tests:

                                                                                      ```bash
                                                                                      npm test
                                                                                      ```

                                                                                      Production health check:

                                                                                      ```text
                                                                                      https://strava-line-bot.onrender.com/health
                                                                                      ```

                                                                                      ## Deployment Notes

                                                                                      The app deploys from GitHub to Render.

                                                                                      After production-facing changes:

                                                                                      1. Commit to GitHub main
                                                                                      2. 2. Wait for Render auto-deploy to become live
                                                                                         3. 3. Check `/health`
                                                                                            4. 4. For LINE Rich Menu changes, verify the actual rich menu through LINE API or LINE Official Account Manager
                                                                                              
                                                                                               5. ## Working With Codex
                                                                                              
                                                                                               6. Before asking Codex to change the project, make sure the repo contains `AGENTS.md`. Codex should read:
                                                                                              
                                                                                               7. - `AGENTS.md`
                                                                                                  - - `README.md`
                                                                                                    - - Relevant docs
                                                                                                      - - Relevant source files
                                                                                                       
                                                                                                        - Suggested prompt:
                                                                                                       
                                                                                                        - ```text
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
                                                                                                          
