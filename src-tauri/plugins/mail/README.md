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
profile and module leases. Draft and contact edits use transactions. Recipient
suggestions prioritize address book entries over collected mail contacts.
The core's authenticated backup barrier pauses ordinary requests, exports
standalone SQLite snapshots and copies the granted originals and attachment
files from the module data root.
The hosted protocol workflow stages a legacy cache containing committed WAL
data, then verifies that the host reads the cache, scheduled Outbox and address
book, detects competing ownership and reopens the edited data after exit.
Linux, Windows and macOS run this check.

The signed offline upgrade command requires a closed profile. It imports the
default or account-specific cache, archived originals and attachment cache.
It publishes the module data before activating the verified package and
records the result in the migration journal. The old account records and files
support rollback. The signed installation workflow uses an isolated legacy
profile and verifies contact queries for both default and custom caches.

Production activation still requires the frontend bundle, scoped Vault,
proxy and file-viewer services, and integration with the automatic upgrade
flow in TASK-026. The production catalog follows the TASK-027 gates.
