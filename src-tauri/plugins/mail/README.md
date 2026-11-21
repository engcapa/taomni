# Mail module

Mail is migrating out of the core application. The core continues to own Mail
session records, recovery locators, Vault access, proxy resolution, file-viewer
integration and backup coordination. The module owns the mail client, unified
inbox, synchronization workers, drafts, contacts, calendar integration and
the `mail-cache` data tree.

`taomni-mail-engine` provides MIME parsing and composition, archive storage,
mbox and EML conversion, and IMAP greeting, TLS, STARTTLS and authentication
over an established socket. The engine plans IMAP UID catch-up and backfill,
reconciles deletions and flags, and fetches paged headers and prefetched bodies
using the persisted cache policy. It also handles POP3 TLS and STLS, login,
UIDL planning and retrieval of raw messages. Its SQLite cache owns persisted
sync watermarks, delayed flag ordering, contact indexing, retention and POP3
local originals. The engine fetches large-message text and attachment
sections and sends bounded IMAP flag and delete requests. The desktop adapter
opens connections using session network settings and resolves user-selected file destinations.
The connection owns its proxy forwarder and releases it when connection
setup fails or the connection closes.

The provisional host serves cached folders, paged headers, bodies, drafts and
address books from `plugins/mail/data/<account-stem>.db` while the SDK holds its
profile and module leases. Draft and contact edits take the SQLite write lock
before reading the rows they will update. Recipient
suggestions prioritize address book entries over collected mail contacts.
The core's authenticated backup barrier pauses ordinary requests, exports
standalone SQLite snapshots and copies the granted originals and attachment
files from the module data root.
The hosted protocol workflow stages a legacy cache containing committed WAL
data, then verifies that the host reads the cache, scheduled Outbox and address
book and detects competing ownership. It checks that an in-flight draft save
blocks a second operation, which can retry after the first finishes. The
reopened host reads the edited and newly created drafts.
Linux, Windows and macOS run this check.

The Mail toolbar's connection test uses the enabled 0.1.3 host for IMAP, POP3
and SMTP authentication. The host also serves the IMAP folder tree on open and
full sync and updates folder subscriptions. The core grants a route to the
selected destination and resolves the account credential for each request.
The host checks TLS against the original hostname and closes the socket on
cancellation. The desktop applies resulting folder metadata to the current
account cache. Version 0.1.4 also delivers composed messages, queued mail,
read receipts and invitation replies over SMTP. The core resolves attachment
paths and passes the authorized MIME bytes through a separate one-use local
route. SMTP acceptance remains independent of storing a Sent copy. The
Outbox waits for a manual retry if a lost reply leaves delivery uncertain.
The protocol job checks authentication, delivery to blind recipients, MIME
framing, explicit rejection and loss of the final DATA reply.

Version 0.1.5 adds a signed renderer for the account and unified inbox panes.
Build it with `pnpm exec vite build --config src-tauri/plugins/mail/vite.config.ts`.
The core shares its React runtime and specific file, dialog, theme and session
services. The signer validates the renderer's source and digest before staging
`frontend/index.js`. Production loads the signed renderer. Browser development
and QA builds can also render the baseline for earlier packages.

Version 0.1.6 runs the selected IMAP folder's header-only step in the signed
host. The core supplies the cached UID snapshot and receives the resulting
headers, flags and watermark through a private one-use connection. The cache
adapter commits the result using its existing stale-state and retention rules.
Version 0.1.7 also runs the header-only account refresh in the host, including
CONDSTORE checks, gap repair, catch-up and reconciliation. Each folder's result
commits independently before the next folder starts. Steps that store message
bodies continue to use the desktop cache adapter during the migration.

Version 0.1.8 executes the Search on server action in the signed host. The
core grants the resolved IMAP route and verifies that the returned headers
belong to the selected account and folder. The shared search engine keeps the
local index, POP3 search and the result order consistent across versions.

Version 0.1.9 sends IMAP message flag changes through the authorized host
connection. The desktop updates the cached flags after the host acknowledges
the full UID set. When the caller drops an in-flight request, the core cancels
the corresponding host operation and releases the route.

Version 0.1.10 also runs unread UID lookup and read-flag batches in the
signed host. Each confirmed batch is committed before the next request.
The unread count is rechecked at the end of a whole-folder operation.

Version 0.1.11 fetches the original IMAP message in the host when it is
absent from the local archive. The host transfers the original bytes over
the authorized companion socket. The desktop checks the reported length
before displaying the source or publishing the user-selected EML file.

Version 0.1.12 fetches and decodes uncached bodies opened by the reader in
the signed host. It preserves large-message part selection and returns MIME
bytes when the account requests extra EML copies. The core resolves the target
directory and commits the compatible body cache. Background prefetch keeps its
pooled connection until the host can reuse a connection across a batch.

Version 0.1.13 downloads uncached IMAP attachments in the signed host. For
large messages, the host requests the selected MIME section. The core checks
the returned byte count and publishes the file atomically before updating the
optional attachment cache.

Version 0.1.14 performs IMAP folder creation, renaming, and deletion in the
signed host. It returns the refreshed folder tree so the core can apply it
in one cache transaction. The caller sees a lost response because the server
may have accepted the mutation.

The signed offline upgrade command requires a closed profile. It imports the
default or account-specific cache, archived originals and attachment cache.
It publishes the module data before activating the verified package and
records the result in the migration journal. The old account records and files
support rollback. The signed installation workflow uses an isolated legacy
profile and verifies contact queries for both default and custom caches.

Production activation still requires the host to own the full sync and cache
lifecycle and use the module-scoped core services. TASK-026 covers the installed
upgrade and rollback. The production catalog follows the TASK-027 gates.
