# Support

Thanks for using Digital Me. Here's how to get help.

## Before you ask

- Run **`digital-me doctor`** — it diagnoses most install and wiring issues and
  prints the exact fix (e.g. the Python venv recipe for your platform).
- Skim the [README](README.md) install section and
  [docs/](docs/) — [ARCHITECTURE](docs/ARCHITECTURE.md),
  [CONTRACTS](docs/CONTRACTS.md), [RELEASING](docs/RELEASING.md).
- Make sure your prerequisites are met: **Node ≥ 22.5**, **pnpm**, and
  **[openclaw](https://github.com/openclaw/openclaw)** installed and on PATH.

## Where to go

| I want to… | Go to |
|---|---|
| Ask a question, share a setup, propose an idea | [Discussions](https://github.com/Amyssjj/digital-me/discussions) |
| Report a bug | [New issue → Bug report](https://github.com/Amyssjj/digital-me/issues/new/choose) |
| Request a feature | [New issue → Feature request](https://github.com/Amyssjj/digital-me/issues/new/choose) |
| Report a security vulnerability | **Privately** — see [SECURITY.md](SECURITY.md). Do not open a public issue. |
| Report a bug in openclaw itself | [openclaw issues](https://github.com/openclaw/openclaw/issues) (upstream) |

## Filing a good bug report

The bug template asks for it, but in short: include your **Digital Me version/commit**,
**OS**, **`node --version`**, **`openclaw --version`**, and the relevant **`digital-me doctor`**
output. Redact personal paths, tokens, and wiki contents before pasting.

## Response expectations

Digital Me is maintained on a best-effort basis as an open-source project. There's no
SLA, but issues and discussions are read. The fastest path to a fix is a clear repro —
or a pull request (see [CONTRIBUTING.md](CONTRIBUTING.md)).
