"""Phone viewport against an actual native listener and its embedded PWA bundle."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def probe(endpoint, pairing_code, case_dir):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='allow')
            page = context.new_page()
            failures = []
            page.on('pageerror', lambda error: failures.append(str(error)))
            page.goto(endpoint, wait_until='networkidle')
            page.get_by_test_id('mobile-first-instance').click()
            page.get_by_test_id('mobile-endpoint').fill(endpoint)
            page.get_by_test_id('mobile-label').fill('Real headless instance')
            page.get_by_test_id('mobile-pair-code').fill(pairing_code)
            page.get_by_test_id('mobile-pair-submit').click()
            expect(page.get_by_test_id('mobile-empty-sessions')).to_be_visible()
            expect(page.get_by_test_id('mobile-connection')).to_have_text('已连接')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(Path(case_dir) / 'mobile-real-headless-phone.png'), full_page=True)
            page.get_by_test_id('mobile-instances-back').click()
            expect(page.get_by_test_id('mobile-instance-open')).to_contain_text('Real headless instance')
            # Wait for installation/control before taking the network away. Only
            # the public shell is available; no API or file content is cached.
            page.wait_for_function('!!navigator.serviceWorker.controller', timeout=15000)
            context.set_offline(True)
            page.reload(wait_until='domcontentloaded')
            expect(page.get_by_test_id('mobile-instance-open')).to_contain_text('Real headless instance')
            page.get_by_test_id('mobile-instance-open').click()
            expect(page.get_by_test_id('mobile-instance-error')).to_be_visible()
            assert not failures, failures
            page.screenshot(path=str(Path(case_dir) / 'mobile-real-offline-shell.png'), full_page=True)
            context.close()
        finally:
            browser.close()
    return {'mobile_real_web': True, 'viewport': '390x844', 'offline_shell': True}
