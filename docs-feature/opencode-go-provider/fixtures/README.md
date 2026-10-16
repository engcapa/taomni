# Directory fixtures (offline, synthetic)

These two source-shaped inputs were **constructed from the design appendix**, not
captured from the live OpenCode Go endpoints. The `provenance` fields are ignored
by the parser. `available.synthetic.json` deliberately omits `deepseek-v4-flash`;
`metadata.synthetic.json` deliberately conflicts with the `kimi-k2.6` seed
(seed wins), classifies the unseeded `fresh-anthropic-model`, and contains an
unknown npm for `omen-alpha`.

The built-in fallback is `src-tauri/resources/opencode-go-catalog.snapshot.json`.
Its source label also says it was generated from the design appendix; the raw
research JSON files referenced by the design were unavailable in this checkout.
`scripts/opencode-go-protocol-seed.json` records the protocol adjudications.

Reproduction without a network call:

```bash
node scripts/update-opencode-go-snapshot.mjs --check
node --test scripts/update-opencode-go-snapshot.test.mjs
```

The snapshot updater without `--check` intentionally contacts the public
metadata endpoint and must not be confused with the offline validation above.
