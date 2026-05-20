# Security Policy

## Reporting a vulnerability

If you discover a security issue in **PF2e Merchant** — anything that could let
a player escalate privileges, write to actors they don't own, leak data, or
otherwise misbehave beyond what the module's design intends — please report it
**privately** rather than opening a public GitHub issue.

Preferred channels (in order):

1. **GitHub Security Advisory** — open one at
   <https://github.com/Iceman1991/Foundry-PF2-Merchant/security/advisories/new>.
   This lets us discuss + ship a fix before the details are public.
2. **Private GitHub issue** if the advisory form isn't an option — open a normal
   issue and prefix the title with `[SECURITY]`; I'll switch it to private and
   continue there.

Please include:

- Foundry VTT version + PF2e system version
- Module version (from `module.json`)
- Steps to reproduce
- Expected vs. actual behaviour
- Whether you've already disclosed the issue anywhere else

## What's in scope

- Code that runs inside Foundry (scripts, hooks, sockets).
- Per-actor flag handling (transaction log, click areas, character discounts,
  vault, etc.).
- The GM-relay socket handlers in `scripts/gm-ops.js` — anything that lets a
  client trick the GM into running an action they shouldn't.

## What's out of scope

- General Foundry-VTT bugs (please report to the Foundry team directly).
- PF2e system behaviour (please report to the PF2e maintainers).
- Local config issues (file permissions, server setup, etc.).
- Cosmetic glitches — those belong in regular issues.

## Response

I'll acknowledge a valid report within a week (usually faster) and aim to ship
a fix within two weeks for high-severity issues. Once a fix is released, the
advisory will be made public with credit to the reporter unless they prefer to
stay anonymous.

## Supported versions

Only the latest released version of the module is actively patched. Fix-forward
is the policy — there are no backports.

Thanks for keeping the module safe.
