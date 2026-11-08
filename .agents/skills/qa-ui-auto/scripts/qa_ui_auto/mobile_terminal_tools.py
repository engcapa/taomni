"""Exercise the production phone terminal's hints and selectable copy snapshot."""
import json
from pathlib import Path

from playwright.sync_api import expect


def run(page, report, peer_receipt):
    checks = []
    before_wire = Path(peer_receipt).read_text(encoding='utf-8')
    page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    screen = page.get_by_test_id('mobile-terminal-screen')
    toast = page.get_by_test_id('mobile-terminal-toast')
    hint = page.get_by_test_id('mobile-terminal-hint')
    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
    expect(toast).to_be_visible()
    expect(page.get_by_test_id('mobile-control-warning')).to_contain_text('可能打断')
    geometry = screen.bounding_box()
    assert toast.evaluate('element => getComputedStyle(element).position') == 'absolute'
    page.screenshot(path=str(report / 'mobile-floating-hint.png'), full_page=True)
    expect(toast).to_have_count(0, timeout=7500)
    assert screen.bounding_box() == geometry, 'Dismissing a hint must not resize the terminal'
    expect(hint).to_have_attribute('aria-expanded', 'false')
    hint.click()
    expect(toast).to_be_visible()
    expect(hint).to_have_attribute('aria-expanded', 'true')
    page.get_by_test_id('mobile-terminal-notice-close').click()
    expect(toast).to_have_count(0)
    checks.append('six-second-overlay-no-terminal-resize-info-reopen-and-dismiss')

    def open_copy():
        page.get_by_test_id('mobile-terminal-more').click()
        page.get_by_test_id('mobile-terminal-copy').click()
        expect(page.get_by_test_id('mobile-terminal-menu')).to_have_count(0)
        field = page.get_by_test_id('mobile-terminal-copy-text')
        expect(field).to_be_focused()
        expect(field).to_have_attribute('readonly', '')
        return field

    field = open_copy()
    snapshot = field.input_value()
    assert all(value in snapshot for value in ('QA_MOBILE_LOG_000', 'QA_MOBILE_LOG_119', 'QA_MOBILE_REPLAY'))
    assert '\x1b' not in snapshot
    page.screenshot(path=str(report / 'mobile-copy-readonly.png'), full_page=True)
    page.get_by_test_id('mobile-terminal-copy-confirm').click()
    expect(page.get_by_test_id('mobile-terminal-copy-dialog')).to_have_count(0)
    assert page.evaluate('navigator.clipboard.readText()') == snapshot
    expect(page.get_by_test_id('mobile-terminal-notice')).to_contain_text('已复制全部')
    expect(page.get_by_test_id('mobile-terminal-more')).to_be_focused()
    checks.append('readonly-copy-all-includes-scrollback-without-ANSI')

    field = open_copy()
    # Chromium's readonly textarea scrolls on arrow keys without moving its
    # caret. Select a word with a real pointer action instead of assuming that
    # keyboard caret navigation works (also reproduced on a plain textarea).
    field.dblclick(position={'x': 20, 'y': 24})
    selected = field.evaluate('element => ({start: element.selectionStart, end: element.selectionEnd, text: element.value.slice(element.selectionStart, element.selectionEnd)})')
    assert selected['text'] == snapshot.splitlines()[0], selected
    expect(page.get_by_test_id('mobile-terminal-copy-confirm')).to_have_text('复制所选')
    page.get_by_test_id('mobile-terminal-copy-confirm').click()
    expect(page.get_by_test_id('mobile-terminal-copy-dialog')).to_have_count(0)
    clipboard = page.evaluate('navigator.clipboard.readText()')
    assert clipboard == selected['text'], {'selected': selected, 'copied': clipboard[:80], 'length': len(clipboard)}
    expect(page.get_by_test_id('mobile-terminal-notice')).to_contain_text('已复制所选')
    checks.append('standard-text-selection-copies-only-the-chosen-range')

    page.set_viewport_size({'width': 844, 'height': 390})
    field = open_copy()
    assert page.get_by_test_id('mobile-terminal-copy-confirm').bounding_box()['y'] < 390
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    field.press('Escape')
    expect(page.get_by_test_id('mobile-terminal-copy-dialog')).to_have_count(0)
    expect(page.get_by_test_id('mobile-terminal-more')).to_be_focused()
    page.set_viewport_size({'width': 390, 'height': 844})
    field = open_copy()
    page.get_by_test_id('mobile-terminal-copy-close').click()
    expect(page.get_by_test_id('mobile-terminal-copy-dialog')).to_have_count(0)
    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
    assert Path(peer_receipt).read_text(encoding='utf-8') == before_wire, 'Hint/copy actions sent terminal input, resize or takeover'
    checks.append('landscape-no-overflow-close-and-Escape-restore-focus-without-terminal-input')
    (report / 'mobile-terminal-tools.json').write_text(json.dumps({'passed': True, 'checks': checks}, indent=2) + '\n', encoding='utf-8')
