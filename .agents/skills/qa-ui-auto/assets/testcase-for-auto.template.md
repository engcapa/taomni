<!-- qa-ui-auto:auto-generated -->
# NewMob - UI E2E Test Cases

> This file is consumed by the `qa-ui-auto` skill via
> `.agents/skills/qa-ui-auto/scripts/run_tests.py`.
>
> Browser mode exercises the React UI plus the Vite Node SSH/SFTP proxies.
> Native mode exercises the same UI through Tauri WebDriver and the Rust IPC
> backend. Remote cases require `qa-ui-auto.config.yaml` to point at a writable
> SSH/SFTP server and `${env:QA_SSH_PASSWORD}` to be set.
>
> Format reminder:
>
>   ## TC-<id>: <title>
>   - tags: smoke, p0
>   - mode: browser
>
>   1. open http://localhost:5000
>   2. click 'role=button[name="Connect"]'
>   3. expect_visible 'text="Connected"'
>   4. screenshot connected.png
>
> Placeholders:
>   ${cfg:ssh.host}       resolved from qa-ui-auto.config.yaml
>   ${cfg:sftp.*}         resolved from qa-ui-auto.config.yaml
>   ${env:VAR}            resolved from environment
>
> Note: config values are not recursively expanded. Use `${env:QA_SSH_PASSWORD}`
> directly in password fields instead of `${cfg:ssh.password}` when the YAML
> stores the password as an environment reference.

## TC-001: Main interface shell renders completed surfaces
- tags: smoke, p0, main
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="menu-bar"]'
3. expect_visible '[data-testid="ribbon"]'
4. expect_visible '[data-testid="quick-connect"]'
5. expect_visible '[data-testid="sidebar"]'
6. expect_visible '[data-testid="session-tree"]'
7. expect_visible '[data-testid="tab-bar"]'
8. expect_visible '[data-testid="status-bar"]'
9. expect_visible '[data-testid="welcome-panel"]'
10. expect_visible 'text="Welcome to NewMob"'
11. expect_visible 'text="Start local terminal"'
12. expect_visible 'text="New session"'
13. expect_visible 'text="Import OpenSSH config"'
14. expect_visible 'text="Active connections"'
15. screenshot 001-main-interface.png

## TC-002: Global settings persist terminal appearance controls
- tags: smoke, p0, settings, appearance
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-settings"]'
3. wait_for '[data-testid="settings-panel"]'
4. expect_visible 'text="Application Theme"'
5. expect_visible 'text="Terminal Appearance"'
6. expect_visible '[data-testid="terminal-appearance-settings"]'
7. expect_visible '[data-testid="terminal-theme-gallery"]'
8. expect_visible '[data-testid="terminal-preview"]'
9. expect_visible '[data-testid="terminal-preview-cursor"]'
10. click 'button[aria-label="Cycle application theme"]'
11. select 'select[aria-label="Terminal cursor"]' 'Underline (steady)'
12. fill 'input[aria-label="Terminal font size"]' '16'
13. fill 'input[aria-label="Scrollback lines"]' '5000'
14. select 'select[aria-label="Right click behavior"]' 'Show context menu'
15. expect_visible '[data-testid="terminal-preview"]'
16. screenshot 002-settings-appearance.png

## TC-003: SSH session editor covers completed configuration sections
- tags: session, ssh, settings, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. expect_visible '[data-testid="session-proto-ssh"]'
5. expect_visible '[data-testid="session-proto-sftp"]'
6. expect_visible '[data-testid="session-proto-rdp"]'
7. expect_visible '[data-testid="session-proto-vnc"]'
8. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
9. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
10. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
11. expect_visible '[data-testid="advanced-ssh-settings"]'
12. expect_visible 'text="SSH-browser type"'
13. expect_visible 'text="Auto-inject OSC 7 cwd reporting"'
14. fill 'input[aria-label="Execute command"]' 'echo qa-ui-auto-session'
15. click '[data-testid="session-section-terminal"]'
16. expect_visible '[data-testid="terminal-settings"]'
17. expect_visible '[data-testid="terminal-appearance-settings"]'
18. expect_visible '[data-testid="terminal-preview"]'
19. click '[data-testid="session-section-network"]'
20. expect_visible '[data-testid="network-settings"]'
21. expect_visible 'text="Keep-alive"'
22. fill 'input[aria-label="Proxy host"]' 'proxy.example.test'
23. fill 'input[aria-label="New forward local address"]' '127.0.0.1:19090'
24. fill 'input[aria-label="New forward remote address"]' '127.0.0.1:22'
25. fill 'input[aria-label="New forward description"]' 'qa-ui-auto-forward'
26. click 'text="Add"'
27. expect_visible 'input[aria-label="Forward local address"]'
28. click '[data-testid="session-section-bookmark"]'
29. wait_for '[data-testid="bookmark-settings"]'
30. fill '[data-testid="session-name"]' 'qa-ui-auto-ssh-settings'
31. fill 'textarea[aria-label="Description notes"]' 'Created by qa-ui-auto'
32. fill 'input[aria-label="Tags"]' 'qa, e2e, ssh'
33. click '[data-testid="session-save"]'
34. wait_for 'text="qa-ui-auto-ssh-settings"'
35. screenshot 003-ssh-session-settings.png

## TC-004: Saved SSH session connects through the sidebar
- tags: session, ssh, terminal, persistence, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-saved-ssh'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-saved-ssh"]'
12. fill '[data-testid="session-search"]' 'qa-ui-auto-saved-ssh'
13. dblclick '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-saved-ssh"]'
14. wait_for '[data-testid="auth-prompt"]'
15. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
16. click '[data-testid="auth-submit"]'
17. wait_for '[data-testid="terminal-pane"]'
18. sleep 2
19. expect_text '[data-testid="terminal-pane"]' 'NewMob SSH terminal'
20. click '[data-testid="terminal-pane"]'
21. type 'whoami'
22. press Enter
23. sleep 1
24. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
25. screenshot 004-saved-ssh-connect.png

## TC-005: Local terminal opens and accepts input in native mode
- tags: terminal, local, p0
- mode: native

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-ui-auto-local'
6. press Enter
7. sleep 1
8. expect_text '[data-testid="terminal-pane"]' 'qa-ui-auto-local'
9. screenshot 005-local-terminal.png

## TC-006: Quick SSH connect opens a live terminal
- tags: ssh, terminal, quickconnect, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. expect_text '[data-testid="terminal-pane"]' 'NewMob SSH terminal'
10. expect_text '[data-testid="terminal-pane"]' 'SSH-browser'
11. expect_text '[data-testid="terminal-pane"]' 'X11-forwarding'
12. click '[data-testid="terminal-pane"]'
13. type 'whoami'
14. press Enter
15. sleep 1
16. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
17. screenshot 006-quick-ssh-terminal.png

## TC-007: Terminal context menu exposes search, display, macros, and event log
- tags: terminal, right-menu, search, p1
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="terminal-pane"]'
10. type 'printf "qa-ui-auto-search\n"'
11. press Enter
12. sleep 1
13. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. expect_visible 'text="Copy All"'
16. expect_visible 'text="Paste"'
17. expect_visible 'text="Find"'
18. expect_visible 'text="Font settings"'
19. expect_visible 'text="Terminal display"'
20. expect_visible 'text="Syntax highlighting"'
21. expect_visible 'text="Record new macro"'
22. expect_visible 'text="Special Command"'
23. expect_visible 'text="Event Log"'
24. click '[data-testid="context-menu-item-find"]'
25. wait_for 'input[placeholder="Find"]'
26. fill 'input[placeholder="Find"]' 'qa-ui-auto-search'
27. press Enter
28. expect_visible 'text="Match"'
29. click 'role=button[name="Close"]'
30. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
31. wait_for '[data-testid="context-menu"]'
32. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
33. expect_visible 'text="Read-only terminal"'
34. expect_visible 'text="Fullscreen terminal"'
35. click '[data-testid="context-menu-item-event-log"]'
36. expect_visible 'text="Event Log"'
37. screenshot 007-terminal-right-menu.png

## TC-008: Attached SFTP browser opens from an SSH terminal and navigates
- tags: ssh, sftp, attached, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. expect_visible '[data-testid="sftp-remote-pane"]'
12. expect_visible '[data-testid="sftp-local-pane"]'
13. expect_visible '[data-testid="sftp-transfer-queue"]'
14. expect_visible '[data-testid="col-header-name"]'
15. expect_visible '[data-testid="col-header-size"]'
16. expect_visible '[data-testid="col-header-modified"]'
17. expect_visible '[data-testid="col-header-type"]'
18. click '[data-testid="sftp-remote-path"]'
19. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
20. press Enter
21. sleep 1
22. expect_visible 'text="REMOTE"'
23. expect_visible 'text="LOCAL"'
24. click '[data-testid="sftp-remote-refresh"]'
25. click '[data-testid="col-header-name"]'
26. screenshot 008-attached-sftp-browser.png

## TC-009: SFTP upload, download, preview, and cleanup
- tags: sftp, transfer, p0
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-transfer.txt"; window.confirm = () => true; }); }'
16. click '[data-testid="sftp-local-new-file"]'
17. wait_for 'text="qa-ui-auto-transfer.txt"'
18. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
19. click '[data-testid="sftp-local-upload-selected"]'
20. wait_for 'text="done"'
21. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
22. click '[data-testid="sftp-remote-download-selected"]'
23. wait_for 'text="done"'
24. click '[data-testid="sftp-remote-preview"]'
25. expect_visible 'text="qa-ui-auto-transfer.txt"'
26. click 'role=button[name="Close"]'
27. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
28. click '[data-testid="sftp-remote-delete"]'
29. sleep 1
30. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
31. click '[data-testid="sftp-local-delete"]'
32. sleep 1
33. screenshot 009-sftp-transfer-cleanup.png

## TC-010: SFTP remote context menu supports chmod, rename, and delete
- tags: sftp, right-menu, chmod, p1
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. eval 'async page => { await page.evaluate(() => { window.__qaPromptValue = "qa-ui-auto-menu.txt"; window.prompt = () => window.__qaPromptValue; window.confirm = () => true; }); }'
16. eval 'async page => { await page.evaluate(() => { const list = document.querySelector(`[data-testid="sftp-remote-list"]`); list?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 220 })); }); }'
17. wait_for '[data-testid="context-menu"]'
18. expect_visible 'text="New folder"'
19. expect_visible 'text="New file"'
20. press Escape
21. click '[data-testid="sftp-remote-new-file"]'
22. wait_for 'text="qa-ui-auto-menu.txt"'
23. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first().click({ button: "right" }); }'
24. wait_for '[data-testid="context-menu"]'
25. expect_visible 'text="Download to local"'
26. expect_visible 'text="Rename"'
27. expect_visible 'text="Permissions"'
28. expect_visible 'text="Delete"'
29. click '[data-testid="context-menu-item-permissions"]'
30. wait_for '[aria-label="Permissions"]'
31. expect_visible 'text="Owner"'
32. expect_visible 'text="Group"'
33. expect_visible 'text="Other"'
34. click 'role=button[name="Apply"]'
35. sleep 1
36. eval 'async page => { await page.evaluate(() => { window.__qaPromptValue = "qa-ui-auto-menu-renamed.txt"; }); }'
37. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first().click({ button: "right" }); }'
38. wait_for '[data-testid="context-menu"]'
39. click '[data-testid="context-menu-item-rename"]'
40. wait_for 'text="qa-ui-auto-menu-renamed.txt"'
41. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu-renamed.txt"`).first().click(); }'
42. click '[data-testid="sftp-remote-delete"]'
43. sleep 1
44. screenshot 010-sftp-context-chmod-rename.png

## TC-011: Saved SFTP session opens a standalone browser tab
- tags: session, sftp, standalone, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-sftp"]'
3. wait_for '[data-testid="session-editor"]'
4. expect_visible '[data-testid="session-proto-sftp"]'
5. fill '[data-testid="session-host"]' '${cfg:sftp.host}'
6. fill '[data-testid="session-port"]' '${cfg:sftp.port}'
7. fill '[data-testid="session-user"]' '${cfg:sftp.user}'
8. click '[data-testid="session-section-bookmark"]'
9. wait_for '[data-testid="bookmark-settings"]'
10. fill '[data-testid="session-name"]' 'qa-ui-auto-sftp-session'
11. click '[data-testid="session-save"]'
12. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-sftp-session"]'
13. dblclick '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-sftp-session"]'
14. wait_for '[data-testid="auth-prompt"]'
15. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
16. click '[data-testid="auth-submit"]'
17. wait_for '[data-testid="sftp-browser"]'
18. expect_visible '[data-testid="sftp-remote-pane"]'
19. expect_visible '[data-testid="sftp-local-pane"]'
20. click '[data-testid="sftp-remote-path"]'
21. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
22. press Enter
23. sleep 1
24. expect_visible 'text="REMOTE"'
25. expect_visible 'text="LOCAL"'
26. expect_visible '[data-testid="sftp-transfer-queue"]'
27. screenshot 011-standalone-sftp-session.png

## TC-012: Attached SFTP open-terminal-here changes the SSH working directory
- tags: ssh, sftp, terminal, integration, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. click '[data-testid="sftp-remote-open-terminal-here"]'
16. sleep 1
17. click '[data-testid="terminal-pane"]'
18. type 'pwd'
19. press Enter
20. sleep 1
21. expect_text '[data-testid="terminal-pane"]' '${cfg:sftp.remote_test_dir}'
22. screenshot 012-sftp-open-terminal-here.png

## TC-013: Session tree search, duplicate, and context menu
- tags: session, right-menu, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-menu'
10. click '[data-testid="session-save"]'
11. wait_for 'text="qa-ui-auto-menu"'
12. fill '[data-testid="session-search"]' 'qa-ui-auto-menu'
13. expect_visible '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]'
14. click '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]'
15. click '[data-testid="session-duplicate"]'
16. wait_for 'text="qa-ui-auto-menu (copy)"'
17. eval 'async page => { await page.locator(`[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]`).click({ button: "right" }); }'
18. wait_for '[data-testid="context-menu"]'
19. expect_visible 'text="Connect"'
20. expect_visible 'text="Edit..."'
21. expect_visible 'text="Duplicate"'
22. expect_visible 'text="Move to folder"'
23. expect_visible 'text="Delete"'
24. screenshot 013-session-tree-right-menu.png

## TC-014: Tab bar right-click menu manages open tabs
- tags: main, right-menu, tabs, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="tab-bar"]'
3. click '[data-testid="ribbon-settings"]'
4. wait_for '[data-testid="settings-panel"]'
5. eval 'async page => { await page.locator(`[data-testid="tab-item"]`).last().click({ button: "right" }); }'
6. wait_for '[data-testid="context-menu"]'
7. expect_visible 'text="Close"'
8. expect_visible 'text="Close others"'
9. expect_visible 'text="Close all"'
10. expect_visible 'text="Duplicate tab"'
11. expect_visible 'text="New local terminal"'
12. screenshot 014-tab-right-menu.png
