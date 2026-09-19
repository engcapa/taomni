---
name: QA local service probes
description: Environment-specific constraints for disposable SSH and MySQL fixtures used by qa-ui-auto.
---

MySQL fixture readiness must use an independent MySQL client against the mapped
host port and execute a real query such as `SELECT 1`. A TCP connect alone is
not enough, and container-internal `docker exec` probes are unreliable in the
current Replit Linux Docker environment.

**Why:** The container-internal probe produced OCI exec failures even though
the published MySQL port accepted valid protocol queries from a separate
client container.

**How to apply:** Keep the fixture's readiness check on the same host-port
path used by the native application. SSH readiness should similarly tolerate a
short-lived published-port race and verify an actual `SSH-` banner.