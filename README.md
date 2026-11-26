# Commonroom

Commonroom is a guest-friendly student space with shared campus and class chats, an issue board and a separate Help board for student questions. The BIC campaign embeds it in Future plans, and it also runs as a standalone web app at `/commonroom/`.

## Open the static site

Open the top-level index.html in your browser. The campaign page and Commonroom preview use relative links, so they also work when GitHub Pages serves the root of main under a repository URL.

The static Commonroom preview includes sample campus and class chats, issues and Help. It saves your preview posts in your browser. For shared posts across browsers, use the server-backed app below.

## Run locally

Use Node.js 24 or later. The project uses browser JavaScript modules, Node’s HTTP server and built-in SQLite. It has zero package dependencies.

```sh
npm start
```

Open [Commonroom](http://127.0.0.1:4317/commonroom/) or the [campaign page](http://127.0.0.1:4317/). Commonroom opens with a browser-scoped guest identity. Use Global chat or choose Class A or Class B. Open Issues to post a concern, reply or change your agree/disagree selection. Open the app in a second browser profile or private window to test independent guest identities in the same space.

SQLite stores guest sessions, memberships, messages, read positions, threads and votes in `.commonroom/data.sqlite`. Restarting the server opens the same database. Set `COMMONROOM_PORT` or `COMMONROOM_DB` to override the defaults. The local listener binds to loopback.

## Verify and deploy

```sh
npm test
npm run build
```

The tests exercise two authenticated accounts, SQLite restart, message polling and retries, unread state, invite expiry and revocation, channel restrictions, reactions, moderation, owner protection and history pagination. The build generates `dist/server/index.js`, which serves the campaign, the standalone frontend and the API.

Hosted operation needs a Cloudflare D1 binding named `DB`. Sites config is in `.openai/hosting.json`, and SQL migrations are in `drizzle/`. Apply migrations in order when deploying outside Sites. The campaign host manages preview access separately from Commonroom guest sessions.

The API uses cookie-based guest sessions, server-side permissions, and durable message and thread IDs for retry. Browser storage holds guest-scoped drafts and unsent messages. Class A and Class B are shared discussion rooms. Hosting access and real class membership would need separate verification before using these rooms for private student information.
