# NewMob Roadmap

> **Status:** Living document. Last updated 2026-05-24.
> **Current version:** v0.1.22
> **Target v1.0:** Q1 2027 (estimated)
>
> **AI-native scope:** the detailed plan lives in `ai-native-plan.md`. Per its §十九 audit (2026-05-24), v2.0–v2.6 of that plan are all ✅ landed on `feature/ai-native-1`. The Theme 2 subsections below are the **original roadmap commitments** (written before `ai-native-plan.md`); they are now annotated with status markers describing where the plan landed differently or where work remains. See **§ "Status vs ai-native-plan and Original Roadmap"** at the end of Theme 2 for the consolidated diff.

## TL;DR

NewMob is evolving from a local-first remote connection manager into a **BYO-cloud-synced, AI-augmented terminal** while preserving its security-first, offline-capable foundation. Two strategic themes drive the next 12 months: **(1) Cloud Vault** — user-configured sync to storage *you* own, not a NewMob-operated service — and **(2) AI-Native features** that make the terminal smarter without compromising privacy.

> **No SaaS, ever.** NewMob will not host a sync service, will not require an account, and will not see your data. You bring the storage (S3 bucket, R2, MinIO, WebDAV server, etc.); the app talks to it directly with credentials only on your device. If NewMob the project disappears tomorrow, your data stays where you put it, in the format you can read.

## Strategic Themes

| Theme | Why now | Success looks like |
|-------|---------|--------------------|
| **Cloud Vault (BYO)** | Users have multiple devices; teams need shared session pools; the existing vault is already E2E-encrypted, making BYO-storage sync low-risk | A user points NewMob at their own S3 bucket / WebDAV server, installs on a new device, unlocks with master password, and has their entire session library + credentials available within 60 seconds — without any NewMob-operated server in the path |
| **AI-Native** | Terminal AI is reaching maturity (Warp, Wave, Cursor); local LLMs (Ollama) make privacy-preserving inference viable; opportunity to differentiate on host-key/credential-aware intelligence | A user describes a task in natural language and executes it safely; error messages explain themselves; history feels like an extension of memory |

## Current State (Phase 0) — v0.1.22

**Stable:** SSH/SFTP via russh, local PTY, VNC relay, port tunnels (Local/Remote/SOCKS), credential vault (AES-256-GCM + Argon2id), command history with prefix match, MobaXterm session import, drag-drop file ops, OSC 7 CWD tracking, OSC 52 clipboard write.

**Known gaps:**
- 🔴 **Security:** `check_server_key()` in `terminal/ssh.rs` accepts all host keys (TOFU not enforced)
- 🟡 RDP, Telnet, Serial — frameworks exist but not functional
- 🟡 No cloud sync, no AI, no team features
- 🟢 Vault export/import only via copying SQLite files

## Non-Goals (Through v1.0 — and Beyond)

To prevent scope creep and preserve the project's architectural promises, NewMob will **not** pursue:

**Permanent non-goals (architectural commitments):**
- ❌ **A "NewMob Cloud" SaaS.** No project-operated sync service, no managed tier, no "free + paid storage" upsell, ever. The cloud vault is **BYO-storage**: the user chooses and configures the backend, owns the bucket/server, and pays the provider directly. NewMob ships a *client*, never a *service*.
- ❌ **User accounts on a NewMob server.** No signup, no login, no email verification, no password reset flow operated by us. The master password is your only identity, and it never leaves your device.
- ❌ **Project-controlled key escrow.** We cannot decrypt your vault, recover your master password, or reset your credentials. By design.
- ❌ **Telemetry that identifies users or syncs without consent.** Any telemetry is opt-in, anonymous, and disclosed.
- ❌ **Vendor-locked AI.** Every AI feature must work with at least one local backend (Ollama). Cloud AI is always optional.

**Through v1.0 (deferred, may revisit):**
- ML-based anomaly detection or RAG over user data (simple statistical methods only)
- Mobile clients (desktop-first; mobile is a separate product surface)
- Browser-based version (Tauri/native only)
- Real-time collaboration / co-editing / screen-sharing (consider for v2.0)
- Plugin/extension system (deferred to v2.0)
- WebRTC peer-to-peer sync (investigate post-v1.0)

---

## Theme 1: Cloud Vault

### Architecture Overview

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────┐
│  Device A    │         │  YOUR storage       │         │  Device B    │
│  (laptop)    │◀───────▶│  (you choose,       │◀───────▶│  (desktop)   │
│              │         │   you configure,    │         │              │
│ vault.db     │  PUT/   │   you pay for it)   │  GET/   │ vault.db     │
│ newmob.db    │  GET    │                     │  PUT    │ newmob.db    │
│ (encrypted)  │         │  • AWS S3           │         │ (encrypted)  │
└──────────────┘         │  • Cloudflare R2    │         └──────────────┘
       │                 │  • Backblaze B2     │                │
       │                 │  • MinIO (selfhost) │                │
       │                 │  • Garage (selfhost)│                │
       │                 │  • Nextcloud / WebDAV│               │
       │                 │  • Any S3-compat    │                │
       │                 └─────────────────────┘                │
       │                                                        │
       └────────── Master password (never leaves device) ───────┘
                  E2E: storage backend sees only opaque ciphertext
                  ▲
                  │
       ┌──────────┴──────────┐
       │  No NewMob server   │
       │  in this picture.   │
       │  We don't proxy,    │
       │  relay, or escrow.  │
       └─────────────────────┘
```

### Supported Storage Backends (User-Chosen)

NewMob ships protocol clients, not backends. The user picks one and configures it themselves.

| Backend | Type | Cost to user | Notes |
|---------|------|--------------|-------|
| **AWS S3** | Managed object store | Pay AWS | Industry standard; works as the reference implementation |
| **Cloudflare R2** | Managed object store | Free tier (10GB, no egress) | Recommended default for individuals — generous free tier |
| **Backblaze B2** | Managed object store | Pay B2 (low cost) | S3-compatible API; cheap for backups |
| **iDrive e2** | Managed object store | Pay iDrive | S3-compatible alternative |
| **Wasabi** | Managed object store | Pay Wasabi | S3-compatible; no egress fees |
| **MinIO** | Self-hosted | Free (your hardware) | Drop-in S3 server; popular for homelab |
| **Garage** | Self-hosted | Free (your hardware) | Lightweight Rust S3 server, geo-distributed |
| **SeaweedFS** | Self-hosted | Free (your hardware) | S3-compatible distributed store |
| **Nextcloud** | Self-hosted or managed | Free or pay provider | Via WebDAV; popular with privacy-focused users |
| **ownCloud** | Self-hosted | Free (your hardware) | Via WebDAV |
| **Any S3-compatible** | Either | Varies | If it speaks S3 API v4, NewMob speaks to it |
| **Any WebDAV server** | Either | Varies | nginx-dav, Apache mod_dav, Caddy WebDAV plugin, etc. |

**What NewMob does not provide:**
- A managed/hosted storage option
- Account creation or SSO with any of these providers
- Bucket provisioning automation (you create the bucket; we PUT/GET to it)
- Billing relationships — your storage bill goes to the provider, never to us

**Onboarding helpers (we do provide):**
- Setup guides in the docs site for the most common providers (R2, S3, MinIO, Nextcloud)
- "Test connection" button that verifies credentials, bucket access, and round-trip integrity before first sync
- Sample IAM policy snippets for AWS S3 (least-privilege: only the bucket and prefix NewMob needs)
- Migration tool: re-target sync to a new backend without losing history

### Design Decisions (with rationale)

| Decision | Choice | Why | Rejected alternatives |
|----------|--------|-----|----------------------|
| **Operating model** | Client-only — we ship a binary; you bring storage | Zero ops cost for the project; user data never touches our infra; survives the project being abandoned | Hosted SaaS tier (operational + trust burden), freemium (creates a service to maintain), "lite" hosted sync via project-owned bucket (still creates a service) |
| **Backend protocols** | S3 API v4 + WebDAV | Two protocols cover ~95% of self-hosted and managed object stores | One protocol only (excludes self-hosters or managed-only users), proprietary protocol (vendor lock-in), file sync via Dropbox/iCloud SDKs (platform lock-in, not BYO) |
| **Encryption** | Reuse existing AES-256-GCM + Argon2id, all client-side | Vault is already E2E-encrypted at rest; no new crypto to audit; works regardless of backend's own encryption claims | Trust the backend's server-side encryption (defeats purpose, ties us to provider claims), age/PGP envelope (more deps, no benefit) |
| **Conflict model** | Last-write-wins + sidecar manifest (v0.2), row-level 3-way merge (v0.3) | Single-user multi-device is 95% of use; LWW is simple and shippable | CRDT (overkill for low write rate), git-style merge UI (UX is worse for non-devs) |
| **Sync trigger** | On change + interval (1/5/15min) + manual | Matches user mental model from Dropbox/iCloud | Real-time websocket sync (server complexity, no benefit for SQLite) |
| **Identity** | Master password = device key; no accounts on any NewMob-operated server | Preserves "no account, no service" promise; works offline; nothing to lose if the project disappears | OAuth/OIDC (requires our own service), passkey/WebAuthn (no Tauri support yet, also implies a server) |
| **Credential storage** | Backend access keys stored as entries in the vault itself | Reuses E2E encryption; sync credentials never written in plaintext | OS keychain (platform fragmentation), config file (plaintext on disk) |

### v0.2.0 — Cloud Vault Foundation

**Goal:** A user with one device can configure their own storage backend and back up/restore their vault to it.

**User flow (BYO storage):**
1. User obtains storage credentials independently (creates an R2 bucket, runs MinIO at home, etc.)
2. In NewMob: Settings → Cloud Vault → "Add Backend" → picks provider type (S3-compatible / WebDAV)
3. Enters endpoint URL, bucket/path, access key, secret key (stored in vault, never plaintext on disk)
4. Clicks "Test Connection" — NewMob verifies reachability, auth, write permission, and round-trip integrity
5. On success, sync is enabled; on failure, error message points at the specific check that failed (auth, network, permissions)

**Features:**
- Backend picker: S3-compatible (with provider presets for AWS, R2, B2, iDrive, Wasabi, MinIO, Garage) + WebDAV (with presets for Nextcloud, ownCloud, generic)
- Provider presets are *just* prefilled endpoint URLs and region hints — no SDKs, no project-side accounts, no API calls to the provider's management plane
- Backend config UI (endpoint, bucket, region, prefix, access/secret keys → stored as vault entries with `kind = "sync_config"`)
- "Test Connection" button: HEAD bucket → small PUT/GET round-trip → DELETE; reports each step
- Status bar sync indicator (`idle | syncing | conflict | error`)
- Manual "Sync Now" + "Pull from Cloud" buttons
- `.newmob-vault` encrypted backup export/import (offline transport — no backend required)
- Conflict prompt: "Remote is newer (modified on Device-Foo at 2026-05-22 14:30) — Keep Local / Pull Remote / Cancel"
- "Forget this backend" action: removes credentials locally; **does not** touch remote data (user's bucket, user's call)

**Technical approach:**
- Add deps: `reqwest = { version = "0.12", features = ["rustls-tls", "json", "stream"] }`, `rusty-s3 = "0.5"` (lightweight signer; avoids the heavyweight `aws-sdk-s3`)
- New module: `src-tauri/src/sync/`
  - `mod.rs` — `SyncConfig`, `SyncManager`, public commands
  - `s3.rs` — S3 v4 signing via `rusty-s3`, GET/PUT/HEAD operations
  - `manifest.rs` — `SyncManifest { device_id, last_sync_at, local_hash, remote_hash, schema_version }`
- Atomic upload: PUT to `<key>.tmp` → S3 copy to `<key>` → DELETE `<key>.tmp`
- WAL checkpoint before snapshot: `PRAGMA wal_checkpoint(TRUNCATE)` to ensure consistent file
- New Zustand store: `src/stores/syncStore.ts`

**Dependencies:** Vault unlock (must be unlocked to sync); existing `vault_put`/`vault_resolve` for credential storage.

**Success metrics:**
- Round-trip backup→restore in under 5 seconds for a 1MB vault
- Zero plaintext bytes in any cloud-bound payload (verified via integration test that intercepts `reqwest`)
- 95th percentile sync time < 2 seconds on 10Mbps connection

**Risks & mitigations:**
- 🔴 *SQLite corruption from in-flight upload* → WAL checkpoint + atomic rename (PUT temp + copy)
- 🟡 *User configures wrong bucket, loses data* → "Verify connection" button before first sync; require successful round-trip before enabling auto-sync
- 🟡 *Clock skew causes false conflicts* → Use content hash (SHA-256), not timestamp, as primary equality check

---

### v0.3.0 — Multi-Device Sync + Session Merge

**Goal:** A user with two devices can edit sessions on either; changes converge automatically; only true conflicts surface.

**Features:**
- Background sync timer (configurable: 1/5/15 min, or off)
- Per-row sync metadata: `sync_version INTEGER`, `last_modified_device TEXT`
- Tombstone table for deleted sessions (prevents resurrection)
- 3-way merge UI: side-by-side comparison for conflicting sessions, per-field winner selection
- WebDAV backend (alternative to S3)
- Sync activity log: timestamped record of last 100 sync events with outcome

**Technical approach:**
- Schema migration in `src-tauri/src/session/db.rs`:
  ```sql
  ALTER TABLE sessions ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_modified_device TEXT;
  CREATE TABLE session_tombstones (
      session_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL,
      device_id TEXT NOT NULL
  );
  ```
- Merge algorithm (per session row):
  ```
  case (local_changed, remote_changed):
    (false, false) → no-op
    (true,  false) → push local
    (false, true)  → pull remote
    (true,  true)  → if local_hash == remote_hash → no-op (concurrent identical edit)
                     else → conflict UI
  ```
- WebDAV client via `reqwest` (PROPFIND/PUT/GET/LOCK) — LOCK provides optimistic concurrency
- Dangling vault references: when rendering session list, mark sessions whose `vault:<id>` reference is missing with a ⚠ icon and a "credential not synced" tooltip

**Dependencies:** v0.2.0 (sync infrastructure must exist).

**Success metrics:**
- 99% of edits sync without user intervention (measured via opt-in telemetry)
- Conflict UI usable: 90% of conflict resolutions complete in under 30 seconds (user study)
- Zero data loss in 1000-iteration concurrent-edit fuzz test

**Risks & mitigations:**
- 🔴 *Merge bug deletes a session* → Tombstone table is append-only; never delete tombstones; provide "Undo Delete" for 30 days
- 🟡 *3-way merge complexity* → Keep merge granularity at row level (whole session) for v0.3; field-level merge only if user feedback demands
- 🟡 *Deleted credential causes auth failure* → Resolution-time fallback to AuthPrompt; clear error message

---

### v0.4.0 — Team Shared Session Pools (Read-Only)

**Goal:** A team lead can share a curated session pool with team members; members can connect but not edit.

**Features:**
- Named shared pools (e.g., "Production Servers", "Staging Cluster")
- Pool subscription model: out-of-band invite (signed JSON file or QR code)
- Per-pool member list with public key fingerprints
- Role enum: `Owner | Editor | Viewer` (only Owner+Viewer in v0.4.0; Editor in v0.4.x)
- Local audit log: `(timestamp, session_id, action)` — connect/edit/disconnect events
- Read-only sessions visually distinct in sidebar (lock icon, "managed by <pool-name>" tag)

**Technical approach:**
- New S3 prefix layout:
  ```
  pools/
    <pool-id>/
      manifest.json         (name, member fingerprints, encrypted with pool key)
      sessions.db.enc       (read-only session collection)
      key-wraps/
        <member-fingerprint>.wrap   (pool key wrapped under member's vault key)
  ```
- Pool key: 256-bit random, never on disk in plaintext
- Key wrapping: AES-256-KW (RFC 3394) — wrap pool key under each member's vault master key
- Schema additions:
  ```sql
  CREATE TABLE pool_subscriptions (
      pool_id TEXT PRIMARY KEY,
      pool_name TEXT NOT NULL,
      role TEXT NOT NULL,                -- 'owner' | 'editor' | 'viewer'
      pool_key_wrapped BLOB NOT NULL,
      last_synced_at INTEGER
  );
  CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      pool_id TEXT,                       -- NULL for personal sessions
      action TEXT NOT NULL,
      details_json TEXT
  );
  ```
- `vault.resolve()` extended to check personal vault → loaded pool vaults (in priority order)

**Dependencies:** v0.3.0 (session merge infrastructure reused for pool sync).

**Member management:**
- *Add member:* existing Owner exports invite (`pool-id + pool-key + manifest signature`); new member imports invite, decrypts pool key with their vault, re-uploads `key-wraps/<their-fingerprint>.wrap`
- *Revoke member:* Owner generates new pool key, re-encrypts `sessions.db.enc`, re-wraps for remaining members; revoked member's wrap is deleted
- *Forward secrecy:* Each pool key rotation creates a new key version; old versions kept for 30 days to allow replay of audit log

**Success metrics:**
- A 5-person team can be onboarded to a shared pool in under 10 minutes
- Pool sync latency under 3s for pools with up to 100 sessions
- Zero unauthorized credential access in security audit (red team review before release)

**Risks & mitigations:**
- 🔴 *Member's vault is compromised → pool key leaks* → Document threat model clearly: "compromise of any member compromises the pool until rotated"; add "Rotate Pool Key" UI as a one-click operation
- 🔴 *Out-of-band invite is intercepted* → Sign invites with Owner's vault key; member verifies signature on import
- 🟡 *Audit log local-only — Owner can't see who connected* → Optional audit log sync (additional S3 prefix) in v0.4.x patch

---

## Theme 2: AI-Native Features

### Architecture Overview

```
                   ┌─────────────────────────────────────┐
                   │  AI Backend Configuration (vault)   │
                   │  • Local: Ollama endpoint + model   │
                   │  • Cloud: Claude / OpenAI API key   │
                   │  • Per-feature override             │
                   └────────────┬────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   ┌────▼────────┐      ┌───────▼─────────┐    ┌────────▼──────┐
   │ Smart       │      │ Privacy Scrubber│    │ Streaming     │
   │ History     │      │ (regex-based)   │    │ (Tauri Channel)│
   │ (offline,   │      │ • API keys      │    │               │
   │  no scrub   │      │ • Private keys  │    │               │
   │  needed)    │      │ • IP:port       │    │               │
   └─────────────┘      │ • PEM blocks    │    │               │
                        └───────┬─────────┘    │               │
                                │              │               │
                        ┌───────▼──────────────▼───────┐       │
                        │  AI Module (src-tauri/src/ai)│       │
                        │  • ai_explain_output()       │◀──────┘
                        │  • ai_translate_command()    │
                        │  • ai_smart_rename()         │
                        │  • ai_summarize_session()    │
                        └──────────────────────────────┘
```

### Design Decisions (with rationale)

| Decision | Choice | Why | Rejected alternatives |
|----------|--------|-----|----------------------|
| **Backend** | Hybrid: Ollama (local) + Claude/OpenAI (cloud); user-configurable per-feature | Privacy by default; quality on demand | Cloud-only (privacy regression), local-only (quality ceiling), bundled tiny model (binary bloat) |
| **API key storage** | Vault entries (`kind = "api_key"`) | Reuse existing E2E-encrypted storage; consistent UX | Plain config file (insecure), OS keychain (platform fragmentation) |
| **Output capture** | Read from xterm.js buffer on-demand | No memory overhead; user controls what's sent | Ring buffer in Rust (memory cost; duplicate state) |
| **Privacy scrubber** | Regex-based, runs before any cloud send, configurable patterns | Predictable, auditable, low overhead | LLM-based PII detection (recursion problem; latency) |
| **Streaming UX** | Side panel + inline preview bubbles (never modify terminal directly) | Preserves terminal as source of truth | Inline AI output (corrupts terminal scrollback, breaks copy-paste) |
| **Confirmation** | Always require explicit user click before executing AI-generated commands | LLM hallucination is a real risk | Auto-execute (unsafe), advisory-only (loses value) |

### v0.2.x — AI Foundation: Smart History (no external API)

> **Status: ❌ Not implemented.** Superseded in spirit by `ai-native-plan.md` v2.2 (Tab Suggestion Source = `history | history+path | history+path+ai`), but the **CWD-aware ranking** + **fuzzy match** + **promote-to-snippet** features below were never built. Current `command_history` schema (`src-tauri/src/session/db.rs:31`) still has no `cwd_context` column; ghost-text is still pure prefix match. Tracking as carryover.

**Goal:** Command history feels like memory — fuzzy, context-aware, instant.

**Features:**
- Fuzzy match for inline ghost suggestions (replaces current prefix-only) — ❌
- CWD-aware ranking: commands run in the current directory bubble to top — ❌ (OSC 7 CWD is tracked at runtime, but never persisted to history rows)
- One-click "promote to snippet" from history palette — ❌
- "Recently in this directory" view in `CommonCommandsPalette` — ❌

**Technical approach:**
- Schema: `ALTER TABLE command_history ADD COLUMN cwd_context TEXT`
- `history_append` accepts `cwd_context: Option<String>`; populated from existing OSC 7 tracking (`__newmob_cwd_sync_done`)
- Fuzzy match in frontend against in-memory cache (`cacheRef` in `useCommandHistory`) — zero IPC overhead
- Ranking formula: `score = recency × frequency × (cwd_match ? 2.0 : 1.0)`

**Dependencies:** None — pure enhancement.

**Success metrics:**
- Inline suggestion accept rate increases by 20% (telemetry, opt-in)
- 80% of "common commands" surfaced are CWD-relevant in user testing

**Risks & mitigations:**
- 🟢 Low overall risk — feature is additive, easy to disable

---

### v0.2.x — Security Fix: Known-Hosts Verification

> **Status: ❌ Not implemented.** `src-tauri/src/terminal/ssh.rs:22` `check_server_key()` still returns `Ok(true)` unconditionally — TOFU is not enforced. The `ai-native-plan.md` work explicitly carved this out as a non-AI security gap and did not address it. **Highest-priority carryover** for the next release: AI features now sit on top of an SSH stack that accepts any host key.

> ⚠ **This is a security gap, not a feature.** Pulled into v0.2.x to ship before any cloud-sync-related expansion of attack surface.

**Goal:** SSH connections verify host keys via TOFU (trust on first use), warn on change.

**Features:**
- New `known_hosts` table: `(host, port, key_type, fingerprint, first_seen_at, last_seen_at)`
- First connect: dialog shows fingerprint, asks user to verify ("Trust" / "Cancel")
- Subsequent connects: silent verify if match; loud "HOST KEY CHANGED" dialog if mismatch (red banner, recommend canceling)
- Settings: "Manage Known Hosts" UI (list, search, remove, manual add)
- Import existing `~/.ssh/known_hosts` on first run

**Technical approach:**
- `src-tauri/src/terminal/ssh.rs` `check_server_key()`: replace `Ok(true)` with table lookup
- Schema migration:
  ```sql
  CREATE TABLE known_hosts (
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      key_type TEXT NOT NULL,         -- 'ssh-ed25519', 'ssh-rsa', etc.
      fingerprint TEXT NOT NULL,      -- SHA256 base64
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (host, port, key_type)
  );
  ```
- Frontend dialog component: `src/components/ssh/HostKeyDialog.tsx`

**Dependencies:** None — independent fix.

**Success metrics:**
- 100% of SSH connections check the host key (verified by integration test)
- Zero silent acceptance of changed host keys

**Risks & mitigations:**
- 🟡 *User overwhelmed by first-connect prompt for every server* → Provide "Trust all hosts in <bucket>" bulk action; pre-populate from `~/.ssh/known_hosts` on first run

---

### v0.3.x — AI Terminal: Error Explanation + NL→Command

> **Status: ✅ Delivered, with deviations.** Implemented under `ai-native-plan.md` v2.0–v2.5 with a substantially expanded scope. Headline differences from the original spec:
>
> - **Backends:** original spec said "Ollama / Claude / OpenAI"; actual implementation supports **8+ providers** via OpenAI-compatible abstraction (DeepSeek, GLM, SiliconFlow, Groq, Cerebras, Gemini, Mistral, OpenRouter, plus a dedicated `anthropic.rs` for Claude Messages API and a `claude-cli` runtime for Claude Code). Default is **DeepSeek** (cloud) with local llama-server fallback, not Ollama.
> - **NL→Command trigger:** original spec was `//` prefix; **shipped as `?? ` prefix** plus `Ctrl+L` Chat Drawer + `Ctrl+K` AI rewrite + voice PTT, all routed through the same `LlmRouter` task-routing layer.
> - **Privacy scrubber:** shipped as `src-tauri/src/chat/redact.rs` (regex-based, shared between FIM/voice/`??`/selection paths), per the spec.
> - **Per-session privacy mode:** shipped as `Session.disableAiWrite` flag (blocks AI write actions, enforced in `agent::safety` middleware).
> - **Plus** (out of original scope): full local mode toggle, Privacy Toggle UI, per-thread provider switching, three-tier confirmation state machine for web search, OS-keyring BYOK storage, ProviderCaps for native web search routing.
>
> See `ai-native-plan.md` §四 (v2.0), §五 (v2.1), §七 (v2.3), §八 (v2.4) and §十九 audit for the full landed surface.

**Goal:** When something fails, the user can ask "why?". When the user knows what but not how, they can ask in English.

**Features:**
- **Error explanation:** non-zero exit → gutter button "Explain error" → streaming response in side panel
- **NL→Command:** `//` prefix in terminal input (or `Ctrl+/` shortcut) → AI returns proposed command in preview bubble → Enter to confirm, Esc to cancel
- **Backend config UI:** in Settings, choose Ollama/Claude/OpenAI per feature; test connection button
- **Privacy scrubber:** configurable regex patterns; default patterns for AWS/GitHub/OpenAI keys, PEM blocks, IP:port
- **Per-session privacy mode:** "Never send this session's output to cloud AI" — vault entry option

**Technical approach:**
- New module: `src-tauri/src/ai/`
  - `mod.rs` — `AiBackend` enum, dispatcher
  - `ollama.rs` — local inference client
  - `anthropic.rs` — Claude API client (uses Messages API with streaming)
  - `openai.rs` — OpenAI Chat Completions client
  - `scrubber.rs` — regex-based output sanitization with audit log of redactions
- Tauri Channel for streaming:
  ```rust
  #[tauri::command]
  pub async fn ai_explain_output(
      output: String,
      session_id: Option<String>,
      on_chunk: Channel<String>,
      state: State<'_, AppState>,
  ) -> Result<(), String>
  ```
- Frontend: read xterm buffer via `terminal.buffer.active.getLine()` on-demand
- `//` prefix detection in `TerminalPanel`'s `onData` handler — intercept before sending to backend
- Side panel component: `src/components/ai/AiSidePanel.tsx` (collapsible, persists last response)

**Dependencies:** v0.2.x (security baseline) — never ship AI output of terminal data without host-key verification on the source.

**Success metrics:**
- p50 time-to-first-token under 1s (Ollama local, llama3.1:8b on M-series Mac)
- p50 time-to-first-token under 2s (Claude Haiku 4.5, broadband)
- Privacy scrubber catches 100% of synthetic test secrets in regression suite
- 0 reports of executing unconfirmed AI commands (UI prevents it)

**Risks & mitigations:**
- 🔴 *AI generates dangerous command (`rm -rf /`)* → Always require explicit confirmation; flag commands containing `rm -rf`, `DROP TABLE`, `> /dev/sd*`, etc., with red warning
- 🔴 *Privacy scrubber misses a pattern* → Make redaction visible to user before send ("Sending scrubbed output; click to preview"); allow user to add custom patterns
- 🟡 *Cloud API cost runs away* → Per-day token budget setting; warn at 80%, hard-stop at 100%
- 🟡 *Hallucinated explanations mislead users* → Always cite the exit code and last 5 lines verbatim; explanation is clearly labeled as AI-generated

---

### v0.4.x — AI-Assisted SFTP + Runbooks

> **Status: ⚠ Partially scaffolded, mostly not implemented.** A `save_as_runbook` tool exists in the `agent` tool registry (`src-tauri/src/agent/tools/`) and the `runbooks` table can be created on demand, but the **end-to-end recorder/player UX, AI rename plan generator, bulk SFTP plan UI, and AI session-naming flow were never built**. This whole section remains as carryover work for the v0.4.x window.

**Goal:** Bulk file operations and repeatable procedures become natural-language tasks.

**Features:**
- **Smart SFTP rename:** select files → "rename .log files to add today's date" → preview diff → confirm — ❌
- **Bulk operations:** "move files older than 30 days to archive/" → AI generates shell or SFTP plan → user reviews → execute step-by-step — ❌
- **Runbook recorder:** click record → execute terminal/SFTP steps → click stop → AI annotates each step → save as named runbook — ❌
- **Runbook player:** select runbook → choose target session → variable substitution prompt → step-by-step execution with pause/retry/abort — ❌
- **AI session naming:** when saving new session, AI suggests name + group based on host/user/options — ❌

**Technical approach:**
- SFTP rename: file list → AI → JSON `[{from, to}]` → diff preview → batch `sftp_rename`
- Runbook schema:
  ```sql
  CREATE TABLE runbooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      steps_json TEXT NOT NULL,
      variables_json TEXT,         -- ["hostname", "date", "env"]
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
  );
  ```
- Step types:
  ```typescript
  type RunbookStep =
    | { type: "terminal"; command: string; expectedExitCode?: number; description?: string }
    | { type: "sftp"; op: "upload" | "download" | "mkdir" | "delete" | "rename"; ... }
    | { type: "wait"; condition: "output_matches" | "exit_code" | "duration"; ... }
    | { type: "checkpoint"; message: string };  // pause + manual confirm
  ```
- Player component: `src/components/runbook/RunbookPlayer.tsx` with progress bar, current-step highlight, pause/retry/abort

**Dependencies:** v0.3.x (AI backend infrastructure).

**Success metrics:**
- 75% of recorded runbooks replay successfully on first attempt (different host)
- AI rename accuracy >95% on common patterns (test corpus of 50 rename tasks)

**Risks & mitigations:**
- 🟡 *Runbook step fails mid-execution leaves system in inconsistent state* → Every step has "rollback hint" field; player prompts user before continuing
- 🟡 *AI rename includes destructive transformation* → Two-stage: generate plan → diff preview → explicit "Apply" button; never auto-apply

---

### v0.4.x — Session Health Dashboard

> **Status: ❌ Not implemented.** No `session_health` table, no latency probe, no anomaly detection. Optional AI session summary on disconnect — also not built. Carryover for v0.4.x.

**Goal:** Visibility into connection reliability; early warning for degraded sessions.

**Features:**
- Per-session latency history chart (sparkline in session tree, full chart in detail view)
- Connection events timeline: `connected | disconnected | error | reconnect`
- Anomaly alerts: latency >3σ above session's moving average → warning badge
- Optional AI session summary: on disconnect, summarize last N lines of activity, save to session notes

**Technical approach:**
- New table:
  ```sql
  CREATE TABLE session_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,        -- 'connected', 'disconnected', 'ping'
      timestamp INTEGER NOT NULL,
      latency_ms INTEGER,
      details_json TEXT
  );
  CREATE INDEX idx_health_session_time ON session_health(session_id, timestamp DESC);
  ```
- Anomaly detection: rolling 100-sample mean + stddev; flag if current >mean+3σ
- Latency probe: piggy-back on SSH keepalive (existing `keepalive_interval`)
- AI summarization: triggered on disconnect, gated by per-session privacy setting

**Dependencies:** v0.3.x (AI backend, optional summarization).

**Success metrics:**
- Less than 1% CPU overhead from health tracking (measured)
- Anomaly false-positive rate <5% (user feedback)

**Risks & mitigations:**
- 🟢 Low — additive feature, easy to disable

---

## Status vs `ai-native-plan.md` and Original Roadmap

This section consolidates the diff between (a) the original Theme 2 commitments above and (b) the v2.0–v2.6 work landed under `ai-native-plan.md` § 十九 (audited 2026-05-24, all marked ✅ on `feature/ai-native-1`).

### A. Delivered — but with material deviations from the original spec

| Original commitment | What actually shipped | Why it differs |
|--------------------|----------------------|----------------|
| Backends: Ollama / Claude / OpenAI | OpenAI-compatible abstraction with **8+ providers** preset (DeepSeek, GLM-4-Flash, SiliconFlow, Groq, Cerebras, Gemini, Mistral, OpenRouter), plus dedicated Anthropic Messages API (`llm/anthropic.rs`), local llama-server sidecar, in-process llama-cpp-2 for FIM, Ollama auto-detected if installed, and Claude Code CLI as opt-in advanced backend (v2.6). Default = DeepSeek (cloud) with 8s timeout fallback to local. | Free-tier / Chinese-friendly providers (GLM, DeepSeek, SiliconFlow) hit "open-the-box" UX better than Ollama-only. |
| NL→Command via `//` prefix | Shipped as **`?? ` prefix** (terminal inline), plus four other entry points: `Ctrl+L` Chat Drawer, `Ctrl+K` AI rewrite overlay, voice PTT, selection toolbar. All routed through `LlmRouter` with task-level provider routing. | `//` collides with comment syntax in many shells; `?? ` is unambiguous and matches the "ask a question" mental model. |
| Privacy scrubber (regex; default API-key/PEM/IP patterns) | Shipped as `src-tauri/src/chat/redact.rs`, **shared** between FIM, voice, `?? ` inline, and selection paths. | Spec-aligned; widened to FIM prefix and selection redaction. |
| Per-session privacy mode | Shipped as `Session.disableAiWrite` boolean, enforced in `agent::safety` middleware (blocks `run_in_terminal`, `sftp_upload`, `save_as_runbook` write actions on flagged sessions). | Spec-aligned in spirit; finer-grained than the original "never send to cloud AI" framing — flag is *write-action* gate rather than *cloud-send* gate. |
| Streaming UX in side panel | Shipped as **AI Chat Drawer** (right side, 380 px default, three responsive breakpoints) with multi-thread history, `@terminal/@file/@session` attachments, ToolCall ActionCard inline cards, 30-day auto-purge + JSON archive export. | Substantially expanded beyond "side panel + inline preview bubbles". |
| Confirmation before executing AI commands | Shipped as `CommandPreviewCard` + risk tier gate (low → 1.5s autorun, medium → manual Enter, high → 800ms anti-misclick + checkbox), plus a hardcoded `shell_safety` blacklist (`rm -rf /`, `mkfs.*`, `dd of=/dev/*`, `chmod -R 777 /`, etc.), and CC permission_prompt MCP server reusing the same gate. | Spec-aligned; full four-state audit machine (`generated | executed | edited | cancelled | blocked_blacklist`). |

### B. Out-of-scope additions (not in original roadmap, but landed)

These came from `ai-native-plan.md` and have no analogue in the original Theme 2 spec.

- **Voice input system** (PTT button, cpal recorder, sherpa-onnx ASR with feature-gated real bridge, Whisper-rs / Vosk fallback feature flags, voice_audit table, intent dispatcher) — `ai-native-plan.md` v2.0 + v2.1.
- **Local llama-server sidecar** (CPU+Vulkan single binary, GPU detection via `ash` Vulkan loader, Metal on macOS, optional CUDA pack download, watchdog + auto-restart) — § 十一.
- **In-process FIM** via `llama-cpp-2` (`local-llm-fim` feature, OnceLock single instance, optional ggml shared build) for `Tab` ghost-text — v2.2.
- **Three-tier model distribution** (ModelScope primary / gh-proxy.com secondary / GitHub canonical, per-model SHA-256, Range-resume, concurrent HEAD probe, user-controllable mirror selection) — § 十一.
- **MCP-style JSON-RPC bridge** (`agent/mcp_server.rs`, 127.0.0.1 random port + bearer token, default off) plus Claude Code `permissions_mcp` + `tools_mcp` reverse exposure — v2.3 + v2.6.
- **Web Search dual-track**: ProviderCaps-aware native passthrough (OpenAI / Anthropic / Gemini / Grok / Mistral / GLM / Qwen / Perplexity native search) + client-side `deep_search` (SearXNG default with 30-day public-instance availability rotation, plus BYOK Tavily / Serper / Brave / Exa / Google CSE stored in OS keyring). Three-tier per-call confirmation state machine. SSRF defense in `web_fetch`. — v2.5.
- **Claude Code CLI integration** (detection + version probe + workspace `--add-dir` whitelist + deny list for `~/.ssh` + `~/.config/newmob`, `--resume <session_id>`, NDJSON streaming with `--include-partial-messages`, watchdog with 3-strike circuit breaker) — v2.6.
- **Full-local mode toggle** (Tauri http allowlist tightened to `127.0.0.1:*` at runtime, hides Claude Code provider, blocks all cloud calls) — § 1.5.
- **Master AI off switch** (`fully_disabled` flag hides Drawer / suppresses Ctrl+L / collapses StatusBar to "AI: off") — § 十.
- **30-day chat retention + JSON archive export, per-thread provider switching, ToolCall ActionCard inline rendering** — v2.4.
- **Compile-time isolation lint** (`build.rs` enforces `asr/` ↔ `llm/` no cross-imports; `cc_bridge::*` cannot `use crate::vault::*`) — § 4.4.
- **MockProvider test framework** + perf-baseline JSONL persistence + qa-ui-auto YAML cases (`TC-AI-001..004`) — § 十六.

### C. Original commitments NOT yet implemented

These are still owed against the original roadmap and are unaffected by `ai-native-plan.md`.

| Item | Status | Notes |
|------|--------|-------|
| **Known-Hosts Verification (TOFU)** — `src-tauri/src/terminal/ssh.rs:22` `check_server_key()` | ❌ Still returns `Ok(true)` unconditionally | **Highest-priority security carryover.** AI features now sit on top of an SSH stack that accepts any host key. Schema (`known_hosts` table), HostKeyDialog, `~/.ssh/known_hosts` import — all unbuilt. |
| **Smart History (CWD-aware ranking + fuzzy match)** | ❌ Schema unchanged | `command_history` has no `cwd_context` column; ghost-text is still pure prefix match. The `ai-native-plan.md` v2.2 work added PATH/files + LLM FIM as additional ghost-text data sources but did not implement CWD-aware ranking on the existing history source. |
| **"Promote to snippet" + "Recently in this directory"** | ❌ | Belongs with Smart History. |
| **AI-Assisted SFTP rename / bulk plan UI** | ❌ | No SFTP-side AI plan generator. `save_as_runbook` tool exists in registry but no recorder UX. |
| **Runbook recorder + player** | ❌ | Schema (`runbooks` table) defined in spec but not migrated; no recorder UI, no player UI, no variable-substitution flow. |
| **AI session naming on save** | ❌ | No code path. |
| **Session Health Dashboard** | ❌ | No `session_health` table, no latency probe piggybacking on SSH keepalive, no anomaly detection, no AI summary on disconnect. |
| **Per-day AI token budget UI + 80%/100% warnings** | ❌ | Original v0.3.x risk mitigation; no implementation. ProviderCaps tracks model metadata but no spend accounting. |

### D. Pre-v1.0 work tracking

For v1.0 (Q1 2027), the AI surface needs:

1. **Land §C carryovers**, prioritising Known-Hosts Verification first (security gate before any further surface area) and Runbook recorder/player second (only large user-facing AI item still missing).
2. **Real-model nightly perf baseline** (Layer 3 in `ai-native-plan.md` § 十六) on a self-hosted GPU runner — currently only Layer 1 + Layer 2 (MockProvider) gate PRs.
3. **Documentation site BYO storage guides + AI privacy guide** (data flow per feature, including where redaction happens).
4. **Decide on `rmcp` SDK migration** — current `mcp_server` / `permissions_mcp` / `tools_mcp` are hand-rolled JSON-RPC; the `rmcp` crate is in `Cargo.toml` but unused. Migration is optional (current implementation is interop-tested with Claude Desktop / Goose / Cursor) but would reduce maintenance.

---

## v1.0 — Production Release

**Goal:** Stable, signed, documented, onboardable. Safe to recommend in production environments.

**Features:**
- Cloud sync: stable, multi-device, with read-only team pools — all BYO-storage
- AI: error explanation + NL→command stable; runbooks GA
- Auto-update via `tauri-plugin-updater`
- Code-signed binaries: Windows (Authenticode), macOS (notarized), Linux (sigstore)
- Comprehensive importers: MobaXterm, PuTTY, OpenSSH config, Termius export
- First-run wizard: vault → optional sync (with backend picker + setup guide links) → optional AI → optional import
- Documentation site:
  - User guide
  - Security & threat model (what NewMob protects, what it doesn't)
  - AI privacy guide (data flows for each AI feature)
  - **BYO storage setup guides** — step-by-step for R2, AWS S3, Backblaze B2, MinIO, Garage, Nextcloud/WebDAV; sample IAM policies; sample `docker-compose.yml` for self-hosters
  - "Migrating between backends" guide
- Performance baseline: WebGL renderer default; 100-tab session opens in <2s
- Accessibility audit: WCAG 2.1 AA for all dialogs and core flows
- Stability: zero open P0/P1 bugs; 30-day soak test on all platforms

**Risks & mitigations:**
- 🔴 *Code signing certificate expires/revoked* → Document renewal process; CI checks expiry 90 days out
- 🟡 *Auto-update breaks app on update* → Staged rollout (5% → 25% → 100%); rollback via `tauri-plugin-updater` version pinning
- 🟡 *Accessibility regressions* → Add automated axe-core checks to CI

---

## Cross-Cutting Concerns

### Migration & Backward Compatibility

Every release adds schema migrations to `src-tauri/src/session/db.rs` and `src-tauri/src/vault/mod.rs`. Migrations are:
- **Forward-only** (no downgrades)
- **Idempotent** (re-running has no effect)
- **Versioned** in the `vault_meta.schema_version` column and a parallel `app_meta` table
- **Tested** on a corpus of golden DB files from each prior release

Cloud-sync introduces a `schema_version` field in the sync manifest; older devices refuse to read newer schemas (fail-safe, not corrupt).

### Telemetry (Opt-In Only)

To inform roadmap decisions, v0.3+ adds **opt-in** anonymous telemetry:
- Feature usage counts (e.g., "ai_explain_output called")
- Error rates (e.g., "sync_conflict resolved")
- Performance percentiles (e.g., "p95 sync duration")

**Never collected:** session content, hostnames, usernames, command text, file contents, IP addresses.

Disabled by default; toggle in Settings; clearly disclosed in onboarding wizard.

### Performance Budgets

| Metric | Budget | Enforcement |
|--------|--------|-------------|
| App cold start | <2s on M1 / <3s on Win11 i5 | CI startup benchmark |
| Terminal first-paint | <500ms after connect | xterm.js metrics |
| Sync round-trip | p95 <2s @ 10Mbps | Sync benchmark |
| AI first-token | p50 <1s local / <2s cloud | AI integration test |
| Memory @ 10 sessions | <300MB RSS | OS metrics |
| Binary size | <50MB per platform | CI artifact check |

### Security Review Checkpoints

| Checkpoint | Trigger | Activity |
|------------|---------|----------|
| Pre-v0.2.0 | Cloud sync ships | Internal review of sync crypto + S3 path |
| Pre-v0.3.x | Known-hosts ships | Verify TOFU implementation against OpenSSH spec |
| Pre-v0.4.0 | Team pools ship | External red team review (1-week engagement) |
| Pre-v1.0 | Production release | Full security audit; CVE check on all deps |

### Open Questions

- ~~**Cloud sync billing:** zero project-side cost (BYO storage); but should there be a "managed" tier?~~ → **Resolved: NO managed tier, ever.** This is now an architectural commitment in the Non-Goals section. The cloud vault is BYO-storage permanently.
- **AI cost transparency:** show running token spend in status bar? → **Yes, in v0.3.x; per-day budget UI**
- **Mobile companion app:** read-only session viewer? → **Out of scope through v1.0**
- **Plugin/extension system:** community-contributed protocols? → **Out of scope; revisit for v2.0**
- **WebRTC for direct device-to-device sync:** bypass cloud entirely? → **Investigate post-v1.0; promising but adds NAT-traversal complexity**
- **Onboarding scripts for self-hosters:** ship a `docker-compose.yml` for MinIO/Garage as part of the docs? → **Yes, in docs site; not bundled in app**

---

## Milestone Summary

| Milestone | ETA | Theme | Headline | Complexity |
|-----------|------|-------|----------|------------|
| v0.2.0 | Q3 2026 | Cloud Vault | S3 sync foundation | Medium |
| v0.2.x | Q3 2026 | AI / Security | Smart history + Known-hosts | Low / Medium |
| v0.3.0 | Q4 2026 | Cloud Vault | Multi-device sync + 3-way merge | High |
| v0.3.x | Q4 2026 | AI | Error explanation + NL→command | Medium |
| v0.4.0 | Q1 2027 | Cloud Vault | Team shared pools (read-only) | Very High |
| v0.4.x | Q1 2027 | AI | Smart SFTP + Runbooks + Health | Medium-High |
| v1.0 | Q1 2027 | Both | Production release | Medium |

> ETAs are aspirational. NewMob is volunteer-developed; ship dates flex based on contribution capacity.

---

## Critical Files (Implementation Reference)

| File | Why it matters |
|------|----------------|
| `src-tauri/Cargo.toml` | `reqwest` (rustls-tls) is the single dep that unlocks cloud + AI |
| `src-tauri/src/vault/mod.rs` | `resolve()` is the integration point for sync configs and AI API keys |
| `src-tauri/src/terminal/ssh.rs` | `check_server_key()` security gap (v0.2.x); terminal output capture (v0.3.x) |
| `src-tauri/src/session/db.rs` | All schema migrations land here |
| `src/lib/history.ts` | `useCommandHistory` — foundation for AI suggestions |
| `src/lib/ipc.ts` | All Tauri command bindings; new commands plug in here |
| `src/stores/` | Add `syncStore`, `aiStore`, `runbookStore` per phase |

---

## Contributing

If you want to help land a milestone:
- **v0.2.0** (Cloud Vault Foundation) — looking for a Rust contributor familiar with S3 signing
- **v0.2.x** (Known-Hosts) — high-leverage, well-scoped; good first contribution
- **v0.3.x** (AI Error Explanation) — frontend-heavy; React + xterm.js experience helpful

File issues with the `roadmap` label. Substantive proposals (new themes, scope changes) start as a GitHub Discussion.

