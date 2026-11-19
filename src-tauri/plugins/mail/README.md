# Mail module

Mail is migrating out of the core application. The core continues to own Mail
session records, recovery locators, Vault access, proxy resolution, file-viewer
integration and backup coordination. The module owns the mail client, unified
inbox, synchronization workers, drafts, contacts, calendar integration and
the `mail-cache` data tree.

The manifest is provisional until the native host, frontend bundle, legacy
cache migration, scoped core-service contract and browser/native acceptance
cases are complete. It must not be added to a production `modules.json` before
TASK-026 and TASK-027 are closed.
