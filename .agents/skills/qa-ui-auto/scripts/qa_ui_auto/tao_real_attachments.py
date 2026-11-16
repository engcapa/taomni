"""Real attachment reuse/removal/delete and explicit invalid-file recovery."""
from . import file_dialog
from .tao_real_flow import CredentialInvalid, RealFlow
from .tao_real_images import FILES, chooser_title, create_image


CHOOSE = '[data-testid="tao-home-file-choose"]'
DELETE = '[data-testid="tao-home-files"] > div:has(> strong):not([data-testid]) button:last-child'


def run(ctx):
    flow = RealFlow(ctx, "attachments", 1)
    picture = (ctx.case_dir / "reusable-image.png").resolve()
    create_image(picture, "3628", "red")
    invalid = (ctx.case_dir / "unsupported.bin").resolve()
    invalid.write_bytes(b"synthetic unsupported attachment")
    with flow.evidence():
        flow.click('[data-testid="tao-home-plus"]')
        flow.click('[data-testid="tao-home-context-attach"]')

        def upload(path):
            before = len(flow.read(FILES)["transport"]["files"])
            file_dialog.run(ctx, dict(kind="open", action="choose", path=str(path), title=chooser_title(), trigger=CHOOSE))
            observed = flow.wait(lambda: flow.read(FILES),
                                 lambda s: len(s["transport"]["files"]) == before + 1 and s["transport"]["files"][-1]["status"] != "pending",
                                 "Native attachment operation did not complete", 120)
            if observed["credentialInvalid"]:
                raise CredentialInvalid()
            return observed

        first = upload(picture)
        flow.require(first["chips"] == 1 and not first["uploadError"], "First reusable image upload failed")
        tasks = len(first["tasks"])
        flow.click('.tao-home-context-chip button[aria-label="Remove reusable-image.png"]')
        flow.require(flow.read(FILES)["chips"] == 0, "Remove reference did not clear the composer chip")
        second = upload(picture)
        flow.require(second["chips"] == 1 and len(second["tasks"]) == tasks and not second["uploadError"],
                     "Repeated file did not reuse content-addressed upload without duplicate tasks/chips")
        flow.record("reuse-dedup-reference", second)
        flow.click(DELETE)
        deleted = flow.wait(lambda: flow.read(FILES),
                            lambda s: s["chips"] == 0 and len(s["transport"]["files"]) == 3 and s["transport"]["files"][-1]["status"] == "fulfilled",
                            "Native file delete did not finish or remove its reference")
        flow.record("native-delete-reference-removed", deleted)
        failed = upload(invalid)
        flow.require(failed["transport"]["files"][-1]["status"] == "rejected" and "not supported" in failed["uploadError"] and failed["chips"] == 0,
                     "Unsupported file did not expose an actionable rejection without a chip")
        flow.record("unsupported-file-rejected", failed)
        recovered = upload(picture)
        flow.require(recovered["transport"]["files"][-1]["status"] == "fulfilled" and recovered["chips"] == 1 and not recovered["uploadError"],
                     "Valid upload after an unsupported file retained a stale error or failed to recover")
        flow.record("valid-upload-recovery", recovered)
        flow.send("Read the attached image and reply only with the four digits and color of the square.")
        flow.reply("recovered-image-recognition", 1)
        flow.record("recovered-image-response", dict(completed=True,
                    digitsRecognized="3628" in flow.last_text(),
                    colorRecognized="red" in flow.last_text().lower(), exactAnswerGraded=False))
        flow.screenshot("attachment-recovery")
    return "Real configured provider attachments: " + flow.outcome
