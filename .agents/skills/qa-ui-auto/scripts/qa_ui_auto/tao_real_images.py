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
  tasks:[...(panel?.querySelectorAll('[data-testid="tao-home-file-task"]')??[])].map(e=>({text:e.textContent,percent:e.querySelector('progress')?.value})),
  uploadError:alerts, credentialInvalid:/\bHTTP\s*[:=]?\s*(401|403)\b|(?:key|credential).{0,40}expired/i.test(alerts)};
})();"""


def run(ctx):
    flow = RealFlow(ctx, "images", 3)
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
            flow.require(not observed["uploadError"] and observed["transport"]["files"][-1]["status"] == "fulfilled" and observed["chips"] == 1,
                         "Actual image upload failed or its context chip is missing: " + observed["uploadError"])
            flow.require(any(t["percent"] == 100 and "completed" in t["text"].lower() for t in observed["tasks"]),
                         "Image upload did not expose completed byte/percentage progress")
            flow.send("Read the attached image. Reply with only its four printed digits, a space, and the name of the colored square in English. Do not use the filename or guess.")
            flow.reply("recognition-" + extension, 1)
            actual = flow.last_text()
            flow.record("image-content-" + extension, dict(responseComplete=True,
                        digitsRecognized=digits in re.sub(r"\s", "", actual),
                        colorRecognized=color in actual.lower(), exactAnswerGraded=False))
            flow.screenshot("image-" + extension)
    return "Real configured provider image flow: " + flow.outcome
