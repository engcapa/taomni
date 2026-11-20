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

The provisional host serves cached folders, paged headers and cached bodies
from `plugins/mail/data/<account-stem>.db` while the SDK holds its profile and
module leases. The host opens existing SQLite data in read-only mode. The
manifest declares the commands and permissions implemented by this host.
The hosted protocol workflow verifies cache reads, competing host rejection,
exit and reopening against an isolated profile on Linux, Windows and macOS.

Production activation requires legacy cache migration, the frontend bundle
and the scoped Vault, proxy and file-viewer services from TASK-026. Add the
module to the production catalog after TASK-026 and TASK-027 are closed.
