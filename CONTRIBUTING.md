# Contributing

Issues and pull requests are welcome, in English or Ukrainian.

- Run it locally: `cd server && npm run dev` gives a local sign-in form at http://localhost:3000. `npm test` runs everything; it needs no network.
- No dependencies. The server and the web app use only Node.js and the browser. Please keep it that way unless there is a strong reason.
- Tests come with the change. A bug fix gets a test that fails without it.
- Both languages. User-facing text lives in `server/src/i18n.js` (server, pages, errors), `server/public/i18n.js` (web app) and `server/cli/slopovyna.mjs` (CLI), always in English and Ukrainian. `npm test` checks that the server and web app catalogs have the same keys in both languages.
- Security first. Anything touching sign-in, agent keys, pairing or files: describe the threat you considered in the pull request. Vulnerabilities go through [SECURITY.md](SECURITY.md), not public issues.

By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE).
