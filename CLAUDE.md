# Notes for Claude

- Commits are authored by the repo owner only: `Choaterboater <280862039+Choaterboater@users.noreply.github.com>`.
  The `.claude/settings.json` startup hook sets this; check `git config user.name` before committing.
- Never add `Co-Authored-By` lines, `Claude-Session` links, or "Generated with Claude Code" text
  to commits, pull request descriptions, or comments.
- Pull requests: one PR per batch of work, with each feature as its own commit. When the owner asks
  for a release, the version bump goes in the same PR. Only an urgent safety fix goes out alone.
  The owner merges from a phone, so fewer PRs is better.
