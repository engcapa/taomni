"""Explicit browser-only progress model, with no native/network assertion."""
import json


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_download_preview cannot establish native download behavior")
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    ctx.page.evaluate("localStorage.setItem('taomni.preview.module-network-fail-once', 'true')")
    ctx.page.evaluate("value => localStorage.setItem('taomni.preview.module-downloads.v1', value)", json.dumps({
        "tasks": [
            {"id": "preview-known", "completedPath": "preview-known.pkg",
             "progress": {"phase": "downloading", "revision": 1, "downloaded": 4096, "total": 8192}},
            {"id": "preview-unknown", "completedPath": "preview-unknown.pkg",
             "progress": {"phase": "failed", "revision": 1, "downloaded": 512, "total": None,
                          "error": "Preview fixture: proxy connection refused"}},
        ], "recoveryErrors": ["Preview fixture: damaged saved task"],
    }))
