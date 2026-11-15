"""Phone terminal gesture oracle; drives DOM inputs, never app handlers/IPC.

Playwright's touchscreen API exposes only tap, not drag. Dispatch standard Touch
DOM events in the real browser and assert rendered xterm scroll position and page
scroll position independently. This establishes the browser event integration,
not a physical iOS/Android keyboard/gesture implementation.
"""
from __future__ import annotations

import json
from typing import Any

from . import StepContext, StepError, verb


@verb('mobile_browser_probe')
def mobile_browser_probe(ctx: StepContext, args: Any) -> None:
    if args == 'desktop-enable-screen' and ctx.cfg['app']['mode'] == 'browser':
        state = getattr(ctx, '_mobile_web_state', None)
        if state is None:
            raise StepError('desktop-enable-screen requires mobile_web fixture')
        state['screen_allowed'] = True
        return
    if args not in ('touch-scroll', 'recovery', 'cookie-gateway', 'terminal-tools', 'desktop-enable-screen') or ctx.cfg['app']['mode'] != 'browser':
        raise StepError('mobile_browser_probe requires browser mode and touch-scroll, recovery, cookie-gateway, terminal-tools or desktop-enable-screen')
    if ctx.dry_run:
        return
    if args == 'terminal-tools':
        from ..deadline import BudgetedPage
        from ..mobile_terminal_tools import run
        page = ctx.page._target if isinstance(ctx.page, BudgetedPage) else ctx.page
        run(page, ctx.case_dir, ctx.values['mobile_receipt'])
        return
    if args == 'cookie-gateway':
        from ..deadline import BudgetedPage
        from ..mobile_cookie_probe import probe
        # The probe's Playwright expect() needs real Locators, not budget proxies.
        page = ctx.page._target if isinstance(ctx.page, BudgetedPage) else ctx.page
        browser = page.context.browser
        if browser is None:
            raise StepError('cookie-gateway requires the existing runner Browser')
        probe(ctx.values['mobile_endpoint'], 'qa-mobile-code', ctx.case_dir,
              assets=ctx.values['mobile_assets'], browser=browser)
        return
    if args == 'recovery':
        from ..mobile_recovery_probe import run
        run(ctx.page, ctx.case_dir)
        ctx.values['mobile_recovery_receipt'] = str((ctx.case_dir / 'mobile-recovery.json').resolve())
        return
    page = ctx.page
    target = page.locator('[data-testid="mobile-terminal-screen"]')
    target.scroll_into_view_if_needed()
    # Replay writes/fit are asynchronous. A freshly opened terminal initially
    # exposes blank row 1, before the retained history has painted.
    page.wait_for_function('''() => Number(document.querySelector('.xterm-accessibility-tree [aria-posinset]')?.getAttribute('aria-posinset')) > 1''', timeout=3000)
    # Scroll back from latest output, via the same standard DOM events the phone
    # browser delivers. Pinch/momentum logic is covered separately by unit tests.
    observation = target.evaluate('''async element => {
      const pageY = window.scrollY;
      const position = () => Number(element.querySelector('.xterm-accessibility-tree [aria-posinset]').getAttribute('aria-posinset'));
      const before = position();
      const box = element.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const top = Math.round(box.top + 30);
      const bottom = Math.round(Math.min(box.bottom - 20, top + 180));
      const finger = y => new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [finger(top)] }));
      const movement = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [finger(bottom)] });
      element.dispatchEvent(movement);
      element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
      // Screen-reader rows are rate-limited by xterm to one update per second.
      const deadline = performance.now() + 2000;
      while (position() >= before && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      return { before, after: position(),
        pageBefore: pageY, pageAfter: window.scrollY, prevented: movement.defaultPrevented };
    }''')
    if not observation['prevented'] or observation['after'] >= observation['before']:
        raise StepError('phone drag did not scroll terminal history: ' + json.dumps(observation))
    if abs(observation['pageAfter'] - observation['pageBefore']) > 1:
        raise StepError('phone terminal drag scrolled the page: ' + json.dumps(observation))
    latest = page.locator('[data-testid="mobile-terminal-latest"]')
    latest.wait_for(state='visible', timeout=3000)
    latest.click()
    page.wait_for_function('''expected => Number(document.querySelector('.xterm-accessibility-tree [aria-posinset]').getAttribute('aria-posinset')) === expected''', arg=observation['before'], timeout=3000)
    observation['latestRestored'] = True
    (ctx.case_dir / 'mobile-touch-scroll.json').write_text(json.dumps(observation, indent=2) + '\n', encoding='utf-8')
