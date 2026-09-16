/**
 * Default the dev proxy to allowing private and loopback targets.
 *
 * The browser preview connects to SSH, SFTP and RDP servers through the Vite
 * dev proxy. Development and QA targets normally live on private addresses
 * (for example 10.0.0.0/8), which the proxy otherwise blocks as an SSRF guard.
 * This module must be imported before the proxy plugins so their module-level
 * `ALLOW_PRIVATE_TARGETS` reads the default. Setting DEV_PROXY_ALLOW_PRIVATE=0
 * or ALLOW_PRIVATE_TARGETS=0 restores the strict block.
 */
if (
  process.env.DEV_PROXY_ALLOW_PRIVATE === undefined &&
  process.env.ALLOW_PRIVATE_TARGETS === undefined
) {
  process.env.DEV_PROXY_ALLOW_PRIVATE = "1";
}

export {};
