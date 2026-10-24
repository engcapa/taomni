# Session defaults and fixed SFTP configuration

New sessions use the shared `none` (direct) network default. Existing sessions
continue to load their saved proxy choice; resetting an existing session restores
that saved choice. There is no startup migration or bulk rewrite. The user's
session-specific default takes precedence over the general application-proxy
default in AGENTS.md.

The SSH editor displays SFTP as static text and saves the stable `sftp` value.
The protocol selector, its editor state and the conditional SCP hint are removed.
The existing runtime protocol parsers and transfers retain their contracts.
The pre-existing SCP transfer cases now start from fixture-owned saved rows;
their upload/download hashes, retained partials and lifecycle assertions remain.

## Verification scope

| Behavior | Cases and layer |
| --- | --- |
| Every network-capable protocol starts direct, including Azure provider selection | `SessionEditor.test.tsx` defaults cases; `TC-SESSION-NET-002` browser/native |
| New-session reset returns to direct; existing route survives reset, saving, reopening and reload | Defaults unit cases; `TC-SESSION-NET-002` browser/native |
| Explicit application, independent, HTTP/SOCKS and SSH jump routes remain available | Defaults/network unit cases; `TC-123`, `TC-131`, `TC-SESSION-NET-001` |
| Fixed SFTP text, no selector, saved advanced/authentication controls | `TC-124`, `TC-127`, `TC-148`, `TC-SESSION-CAP-001` |
| Actual direct SSH/SFTP works while application proxy is unreachable; explicit proxy fails and direct retry succeeds | `TC-SESSION-SFTP-001` native only: real Rust protocols, SQLite and a run-owned non-listening proxy endpoint |
| Previously saved SCP transfers preserve listing, exact bytes, partial recovery, pause/cancel/retry and background ownership | `TC-SESSION-SCP-001`, `TC-SESSION-SCP-002`, `TC-SESSION-SCP-003` native |

The initial regression probe failed on the old code: the new SSH session chose
`app`, and the SSH browser control was still a `SELECT`. Related frontend unit
checks cover the editor, network normalization, capabilities, SSH options,
connection commands and the session store. Python fixture unit checks cover
SQLite/auth serialization, the isolated proxy endpoint and isolation refusal.

Only unit tests and static checks run locally. Browser and native execution uses
`qa-ui-auto-platforms.yml` on Linux, Windows and macOS with `scope=selected`,
`modes=browser,native`, and the exact IDs above. Browser evidence covers renderer
behavior; native evidence adds actual persistence and network/protocol behavior.
The selection contains 24 browser and 30 native case/platform executions. Existing
browser-only cases retain that boundary; screenshots do not claim a visual review.
