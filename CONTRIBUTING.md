# Contributing to MpVFX

Bug reports and focused pull requests are welcome. Before investing in a large change, open a
proposal so scope and product direction can be agreed on.

## Development workflow

1. Use Node.js 22.23.2.
2. Run `npm ci` inside `studio/`.
3. Add or update a behavioral test before changing behavior.
4. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run release:check`.
5. Keep local projects, generated media, credentials, and recovery data out of commits.
6. Never commit AI-agent chat histories, prompts/responses, conversation exports, or session state.
7. Do not add media fixtures unless they are synthetic, explicitly allowlisted, checksummed, and
   documented with provenance.

Pull requests should be narrow, explain user-visible behavior, identify test coverage, and disclose
any new dependency, network destination, telemetry, AI model, copied material, or generated asset.

## Rights and provenance

Only submit work you have the right to contribute. Unless you explicitly state otherwise, any
contribution intentionally submitted for inclusion in MpVFX is provided under the Apache License,
Version 2.0, including its copyright and patent terms. Mark material clearly as “Not a
Contribution” if it is supplied only for discussion or diagnosis. See [LICENSE](LICENSE).

Do not add copied questions, answers, code, media, fonts, models, or icons without recording the
creator, exact source, license, and modifications. Changes to the Stack Exchange corpus must also
regenerate its `sources.jsonl` attribution manifest.

## Security reports

Do not open a public pull request for an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).
