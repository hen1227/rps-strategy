# Contributing

Thanks for looking. RPS Strategy is a fan implementation of WebGoatGuy's games
(the Credits page on the site says more), built and run by one person, so the
process here is small.

## Before your first pull request: the CLA

Everyone who contributes signs the [Contributor License Agreement](CLA.md)
once, before their first pull request is merged. Open the pull request as
normal. A check called **CLA** will comment with the sentence to post, and it
passes once you've posted it.

Why an AGPL project asks for a CLA: the App Store build can't ship under the
AGPL alone, because Apple's terms add restrictions the AGPL forbids. So it ships
under separate terms, which only works for code the project's owner has the
right to license that way. The owner is Henhen1227, LLC, my company, and the CLA
gives it that right for your contribution. It also leaves room to license the
project differently later, including commercially. It doesn't take anything
away from the public licence: whatever is published here under the AGPL stays
available to everyone under the AGPL.

Code posted anywhere else (an issue, a comment, Discord) can't be used until
its author has signed, so please send it as a pull request.

The engine, [RPSFish](https://github.com/hen1227/rpsfish), is a separate
repository under the LGPL, and it has no CLA.

## Licences

| What | Licence |
| --- | --- |
| Everything not listed below | AGPL-3.0-or-later ([LICENSE](LICENSE)) |
| The bot kit: `backend/internal/botclient/*.py`, plus `docs/bots.md`, `docs/rpsi.md` and `docs/notation.md` and their copies in `backend/internal/botclient/` | MIT |
| `frontend/modules/rpsfish/`, the native module that wraps the engine | LGPL-3.0-or-later |

[REUSE.toml](REUSE.toml) is the authoritative version of this table, and
`pipx run reuse lint` checks it. A new file that isn't AGPL needs a table
there. [NOTICE.md](NOTICE.md) covers the game designs, the engine, and the
artwork.

## Working on it

[README.md](README.md#run-locally) has the setup. Before opening a pull
request, run both suites:

```sh
cd backend && go test ./...
cd frontend && npm test
```

If a player would notice your change, add one line to the top section of
[CHANGELOG.md](CHANGELOG.md). [AGENTS.md](AGENTS.md) says what counts and how
to write it.
