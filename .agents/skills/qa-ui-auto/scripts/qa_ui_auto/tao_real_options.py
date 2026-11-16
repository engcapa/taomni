"""Real model/mode/thinking/web/read-url and usage UI acceptance."""
import json
import secrets

from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "options", 5)
    with flow.evidence():
        for mode, model, thinking in (("ask", "deepseek-flash", False),
                                      ("do", "deepseek-v4-pro", True),
                                      ("research", "deepseek-flash", True)):
            if flow.calls:
                flow.new_chat()
            flow.click('[data-testid="tao-home-mode-' + mode + '"]')
            # Mode selection may install defaults; explicitly set intended values.
            flow.option("model-" + model)
            active = flow.read("return document.querySelector('[data-testid=\"tao-home-capabilities\"]').textContent;")
            if ("Thinking" in active) != thinking:
                flow.option("thinking")
            active = flow.read("return document.querySelector('[data-testid=\"tao-home-capabilities\"]').textContent;")
            if "Web" in active:
                flow.option("web")
            token = "QA" + secrets.token_hex(5)
            flow.send("Synthetic UI test: calculate 17 times 19 (323). Reply with 323 and " + token + ". No actions or tools, under 30 words.")
            state = flow.reply(mode + "-" + model, 1, token, check_marker=True)
            flow.require("323" in flow.last_text(), "Real model returned wrong arithmetic")
            detail = flow.read("return {selected:document.querySelector('[data-testid=\"tao-home-mode-" + mode + "\"]').getAttribute('aria-selected'), model:document.querySelector('[data-testid=\"tao-home-capabilities\"]').textContent, thinking:document.querySelectorAll('.tao-home-thinking-block').length,usage:document.querySelectorAll('.tao-home-usage-line').length};")
            flow.require(detail["selected"] == "true" and model.replace("deepseek-", "") in detail["model"] and state["usage"] and detail["usage"] == 1,
                         "Real mode/model selection or actual input/output usage is missing")
            if thinking:
                flow.require(detail["thinking"] > 0, "Thinking-enabled real request emitted no thinking block")
            flow.record("mode-model-thinking-usage", detail)
            flow.click('[data-testid="tao-home-usage-pill"]')
            usage = flow.read("return [...document.querySelectorAll('[role=\"dialog\"]')].map(e=>e.textContent).join(' ');")
            flow.require("Input" in usage and "Output" in usage and "tokens" in usage,
                         "Actual usage popover is incomplete")
            flow.click('[data-testid="tao-home-usage-pill"]')
            flow.screenshot(mode + "-" + model)

        flow.new_chat()
        flow.click('[data-testid="tao-home-mode-ask"]')
        flow.option("model-deepseek-flash")
        active = flow.read("return document.querySelector('[data-testid=\"tao-home-capabilities\"]').textContent;")
        if "Thinking" in active:
            flow.option("thinking")
        if "Web" not in active:
            flow.option("web")
        flow.send("Use web_search to find the official Python website. Return its URL and one short sentence; cite the tool result. Do not answer from memory.")
        flow.reply("real-web-search", 1)
        search = flow.read("return {steps:document.querySelectorAll('.tao-home-search-step').length, sources:document.querySelectorAll('.tao-home-sources a').length,usage:[...document.querySelectorAll('.tao-home-usage-line')].at(-1)?.textContent??''};")
        flow.require(search["steps"] > 0 and search["sources"] > 0 and "python.org" in flow.last_text(),
                     "Real Web response did not provide a search step, source and official URL")
        flow.record("commercial-web-sources", search)
        flow.click('[data-testid="tao-home-side-toggle"]')
        flow.click('[data-testid="tao-home-side-tab-sources"]')
        flow.require(flow.read("return document.querySelector('[data-testid=\"tao-home-sources\"]')?.querySelectorAll('article').length??0;") > 0,
                     "Real sources did not populate the companion panel")
        flow.screenshot("web-sources")

        flow.option("web")
        flow.send("Use the provided deepseek_read_url server tool to open https://example.com and return its page title and a short quotation. You must call deepseek_read_url; do not answer from memory.")
        flow.reply("real-read-url", 2)
        flow.require("Example Domain" in flow.last_text(), "Real read_url reply lost the page title")
        usage = flow.read("return [...document.querySelectorAll('.tao-home-usage-line')].at(-1)?.textContent??'';")
        import re
        match = re.search(r"Read URL\s+(\d+)|Fetch\s+(\d+)", usage)
        flow.require(bool(match) and any(value and int(value) > 0 for value in match.groups()),
                     "Real read_url usage did not record an actual fetch")
        flow.record("commercial-read-url", dict(title=True, usage=usage))
    return "Real DeepSeek options: " + flow.outcome
