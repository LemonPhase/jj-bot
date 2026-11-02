# Bot chat

A user chats directly with one bot. The bot replies in the conversation, and when asked for work it starts a task, posting a card that links to it.

## Sub-features

- `chat-send` sends a message and shows the bot's reply.
- `chat-starts-task` turns a request for work into a task, with an inline task card.
- `chat-history` keeps the conversation across reloads.
- `chat-inspector` opens the bot's details and memory from `Profile`.

## How to get to it (user POV)

- Choose a bot in the sidebar's `Bots` list.
- The address `#/bots/:botId`, or `#/bots` for the first bot.
- Right after creating a bot in Studio.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists, created through [bot-studio.md](bot-studio.md).

- **Open the chat.** Run `$P "$RUN" open '#/bots'`. The main region is named `Chat with Nova`, and the log `Messages with Nova` reads `No messages yet. Say hello to Nova.`.
- **Send.** Type and press Enter, or choose `Send`. Run `$P "$RUN" fill "getByRole('textbox', { name: 'Message Nova' })" "hello"` and `$P "$RUN" press Enter`. The `Send` button stays disabled while the textbox is empty.
- **Reply.** Wait about 2 s and run `$P "$RUN" snapshot "getByRole('log', { name: 'Messages with Nova' })" --filename=chat.yml`. The log holds `You: hello` and a reply from `Nova` (the scripted model answers "Hello! Tell me what you'd like done and I'll start a task for it.").
- **Request work.** Send `Please write a penguin report`. Within a few seconds the reply reads `I've started a task for that. Created task "Please write a penguin report" (task_...)`, followed by a link named `Task: Please write a penguin report <state> · v1` pointing at `#/tasks/<taskId>`.
- **Confirm.** Run `curl -s "$U/api/tasks"`: the task exists with Nova as coordinator. `curl -s "$U/api/bots/<botId>/messages"` holds both turns. Follow the card link and the task screen opens ([tasks.md](tasks.md)).

## Gotchas

- Replies arrive asynchronously from the worker; snapshot after the reply lands, not right after `Send`.
- Bots may create a limited number of tasks from chat per hour (`JJ_TASKS_PER_BOT_PER_HOUR`, default 10). A long run of `chat-starts-task` checks on one bot can be refused with `RATE_LIMITED`; use a fresh bot or a fresh run.
- `Profile` opens an inspector on the chat screen with `Save details`, `Save memory` (both disabled until something changes) and `Archive bot`. Its edit, memory and archive flows haven't been driven yet; snapshot before asserting on them.
- The inline card's name includes the task's live state (`running`, `done`), so match it by prefix (`getByRole('link', { name: /^Task: Please write/ })`).
