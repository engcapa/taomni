"""Real OS chooser -> native Files API -> image recognition, with retained inputs."""
from __future__ import annotations

import json
import platform
import re
import secrets

from . import file_dialog
from .steps import StepError
from .tao_real_flow import CredentialInvalid, RealFlow


def chooser_title():
    # rfd GTK explicitly defaults to this title; Windows uses the OS locale.
    return "Open File" if platform.system() == "Linux" else "打开"


def create_image(path, digits: str, color: str):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (800, 360), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 100)
    except OSError:
        font = ImageFont.load_default(size=100)
    draw.rectangle((30, 30, 210, 210), fill=color)
    draw.text((260, 60), digits, fill="black", font=font)
    image.save(path)


FILES = r"""return (() => {
 const root=document.querySelector('[data-tao-active="true"]');
 const panel=root.querySelector('[data-testid="tao-home-files"]');
 const alerts=[...(panel?.querySelectorAll('[role="alert"]')??[])].map(e=>e.textContent).join('\n');
 return {transport:window.__taomniQaTaoProvider.observe(),
  chips:root.querySelectorAll('.tao-home-context-chip').length,
  prepared:[...(panel?.children??[])].filter(e=>e.querySelector('strong') && e.querySelector('small')).map(e=>({name:e.querySelector('strong').textContent,bytes:e.querySelector('small').textContent})),
  previews:[...root.querySelectorAll('.tao-home-context-preview')].map(e=>e.textContent),
  tasks:[...(panel?.querySelectorAll('[data-testid="tao-home-file-task"]')??[])].map(e=>({text:e.textContent,percent:e.querySelector('progress')?.value})),
  uploadError:alerts, credentialInvalid:/\bHTTP\s*[:=]?\s*(401|403)\b|(?:key|credential).{0,40}expired/i.test(alerts)};
})();"""


def assert_image_ready(state, provider, filename, size):
    if state["uploadError"] or state["transport"]["files"][-1]["status"] != "fulfilled" or state["chips"] != 1:
        raise StepError("Image preparation failed or its context chip is missing: " + state["uploadError"])
    if provider == "opencode-go":
        # Go stages local content; image bytes are submitted with the chat request.
        # A fictitious server-upload task would misrepresent that contract.
        if not any(f["name"] == filename and f["bytes"] == f"{size} bytes" for f in state["prepared"]):
            raise StepError("Local image preparation did not expose its actual name and byte size")
        if not any(f"File will be sent with the message: {size} bytes" in text for text in state["previews"]):
            raise StepError("Local image reference did not explain submission with the message")
    elif provider == "deepseek-app":
        if not any(t["percent"] == 100 and "completed" in t["text"].lower() for t in state["tasks"]):
            raise StepError("Image upload did not expose completed byte/percentage progress")
    else:
        raise StepError("Unsupported provider image preparation contract: " + provider)


def run(ctx):
    flow = RealFlow(ctx, "images", 3)
    provider = json.loads((ctx.case_dir / "real-provider-config.json").read_text(encoding="utf-8"))["provider"]
    with flow.evidence():
        flow.click('[data-testid="tao-home-plus"]')
        flow.click('[data-testid="tao-home-context-attach"]')
        file_dialog.run(ctx, dict(kind="open", action="cancel", title=chooser_title(), trigger='[data-testid="tao-home-file-choose"]'))
        flow.require(not flow.read(FILES)["transport"]["files"], "Cancel triggered a native upload")
        flow.record("chooser-cancel-no-upload", flow.read(FILES))
        for index, (extension, color) in enumerate((("png", "red"), ("jpg", "blue"), ("webp", "green"))):
            if index:
                flow.new_chat()
                flow.click('[data-testid="tao-home-plus"]')
                flow.click('[data-testid="tao-home-context-attach"]')
            digits = str(secrets.randbelow(9000) + 1000)
            path = ctx.case_dir / ("synthetic-picture-" + str(index) + "." + extension)
            create_image(path, digits, color)
            before = len(flow.read(FILES)["transport"]["files"])
            file_dialog.run(ctx, dict(kind="open", action="choose", path=str(path.resolve()), title=chooser_title(), trigger='[data-testid="tao-home-file-choose"]'))
            observed = flow.wait(lambda: flow.read(FILES),
                                 lambda s: len(s["transport"]["files"]) == before + 1 and s["transport"]["files"][-1]["status"] != "pending",
                                 "Actual native image upload did not finish", 120)
            flow.record("upload-" + extension, observed)
            if observed["credentialInvalid"]:
                raise CredentialInvalid()
            if provider == "opencode-go":
                flow.click('.tao-home-context-chip-label')
                observed = flow.read(FILES)
            assert_image_ready(observed, provider, path.name, path.stat().st_size)
            flow.record("image-ready-" + extension, observed)
            if provider == "opencode-go":
                flow.click('.tao-home-context-chip-label')
            flow.send("Read the attached image. Reply with only its four printed digits, a space, and the name of the colored square in English. Do not use the filename or guess.")
            flow.reply("recognition-" + extension, 1)
            actual = flow.last_text()
            digits_recognized = digits in re.sub(r"\s", "", actual)
            color_recognized = color in actual.lower()
            flow.record("image-content-" + extension, dict(responseComplete=True,
                        digitsRecognized=digits_recognized,
                        colorRecognized=color_recognized, exactAnswerGraded=True))
            flow.screenshot("image-" + extension)
            flow.require(digits_recognized and color_recognized, "Actual image answer did not identify the generated digits and color")
    return "Real configured provider image flow: " + flow.outcome
