---
name: Mounted polling test clocks
description: Avoid false polling coverage and frozen waitFor retries in component tests.
---

Mounted timer tests must control the clock when the component installs its timers,
not only when advancing time later. With interval-only fake timers, waitFor retries
also use the controlled interval; explicitly flush async React connection updates
before synchronous assertions or advance the matching clock.

**Why:** Switching clocks after mounting produced a passing observation assertion
without exercising the existing poll. Controlling intervals before mount then
exposed that waitFor could not retry on the frozen clock.

**How to apply:** For mounted polling tests, prove the callback actually read the
current state after each time advance, separate allowed prompt reads from historical
reads, and verify cleanup stops subsequent reads. Do not infer poll coverage from
unchanged DOM state alone.
