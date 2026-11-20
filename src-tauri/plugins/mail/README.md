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
local originals. The desktop adapter opens connections using session network
settings and resolves attachment bytes and user-selected file destinations.
The connection owns its proxy forwarder and releases it when connection
setup fails or the connection closes.

The manifest is provisional until the native host, frontend bundle, legacy
cache migration, scoped core-service contract and browser/native acceptance
cases are complete. It must not be added to a production `modules.json` before
TASK-026 and TASK-027 are closed.
