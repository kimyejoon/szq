# Contributing to szq

Thanks for helping! szq is small on purpose: **zero runtime dependencies**, plain CommonJS, Node >= 18.

## Setup

```sh
git clone https://github.com/kimyejoon/szq.git
cd szq
node --test            # whole suite; takes about a minute (it starts real processes)
node bin/szq.js --help
```

Tests use only temporary directories (`SZQ_HOME` / `SZQ_CONFIG` are redirected per test), so they never
touch your real state or agent settings.

## Guidelines

- **No dependencies.** If you think you need one, open an issue first.
- **Cross-platform.** Anything that differs on Windows goes through `src/platform.js`. Please add a test,
  and mark POSIX-only tests with `skip: process.platform === 'win32'`.
- **The guard must stay fail-open and fast.** `src/guard/` runs before every shell command of an agent;
  an error there must never block the agent, and it must not read the network or spawn processes.
- **Security-sensitive areas** (state directory permissions, git invocations, cmd.exe quoting, settings
  installer) need a test that fails without your change. See [SECURITY.md](SECURITY.md).
- Keep messages translatable: user-facing CLI strings live in `src/i18n.js` (English + Korean).
- Update `CHANGELOG.md` for user-visible changes.

## Adding an agent adapter

Read [docs/ADAPTERS.md](docs/ADAPTERS.md). A new adapter needs: the agent's documentation link, a
parse/allow/deny implementation matching the documented hook protocol, config install/uninstall, and tests
in `test/adapters.test.js` and `test/guard.test.js`. Mark it `maturity: 'experimental'` until it has been
verified against a real installation.

## Commit messages and pull requests

Small, focused pull requests with a clear description of the problem and how you verified the fix.
By contributing you agree that your contribution is licensed under the MIT License.

## Conduct

Be kind and assume good faith. Harassment or personal attacks are not tolerated; maintainers may remove
comments and block users who persist.
