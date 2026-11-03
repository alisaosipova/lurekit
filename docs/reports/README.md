# Reports

Written summaries of published benchmark runs. The data for each report is in the bundles under
[`reports/`](../../reports/); a summary adds no numbers that are not in those bundles.

| date | report | bundles |
|---|---|---|
| 2026-11-02 | [Claude Code 2.1.316: first published runs](2026-11-02-claude-code-2.1.316.md) | `aab-20261102112637-5c55ad74`, `aab-20261102113300-fb754883`, `aab-20261102113408-528c7e8c` |
| 2026-11-02 | [Claude Code 2.1.316: stability (k=3)](2026-11-02-claude-code-2.1.316.md#stability-k3) | `aab-20261102151537-ce30070e` |
| 2026-11-02 | [Claude Code 2.1.316: configuration comparison, bare vs hardened](2026-11-02-claude-code-2.1.316.md#configuration-comparison-bare-vs-hardened) | `aab-20261102161512-ca5fe106` (bare), `aab-20261102162151-468579b9` (hardened) |
| 2026-11-03 | [Claude Code 2.1.317: four k=3 arms, default and netread permissions](2026-11-03-claude-code-2.1.317-k3.md) | `aab-20261103062614-49ac1ce7` (hardened), `aab-20261103071018-88a78d8f` (bare), `aab-20261103075404-f5fe15ec` (bare + netread), `aab-20261103091409-dff0d34a` (hardened + netread) |

The 2026-11-02 report carries a [validity note](2026-11-02-claude-code-2.1.316.md#validity-note-2026-11-03):
its `resisted` verdicts for the loopback feed and web scenarios (AAB-017, AAB-021, AAB-056) are
not measurements.
