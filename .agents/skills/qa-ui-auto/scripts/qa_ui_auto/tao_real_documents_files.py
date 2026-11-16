"""Actual code/PDF files, with fresh content unavailable in prompt or filename."""
import secrets

from . import file_dialog
from .tao_real_flow import CredentialInvalid, RealFlow
from .tao_real_images import FILES


def run(ctx):
    flow = RealFlow(ctx, "document-files", 2)
    with flow.evidence():
        for index, extension in enumerate(("py", "pdf")):
            if index:
                flow.new_chat()
            marker = "QA" + secrets.token_hex(6)
            path = (ctx.case_dir / ("synthetic-document." + extension)).resolve()
            if extension == "py":
                path.write_text('QA_DOCUMENT_MARKER = "' + marker + '"\n\ndef multiply(a, b):\n    return a * b\n', encoding="utf-8")
                prompt = "Read the attached code document. Reply with its QA_DOCUMENT_MARKER value and the result of multiply(6,7). Do not guess or use the filename."
                answer = "42"
            else:
                from reportlab.pdfgen.canvas import Canvas
                canvas = Canvas(str(path))
                canvas.setFont("Helvetica", 20)
                canvas.drawString(65, 750, "QA_DOCUMENT_MARKER: " + marker)
                canvas.drawString(65, 710, "Quarterly amount: 73")
                canvas.drawString(65, 670, "Approved amount: 19")
                canvas.save()
                prompt = "Read the attached PDF. Reply with its QA_DOCUMENT_MARKER value and the sum of its two amounts. Do not guess or use the filename."
                answer = "92"
            flow.click('[data-testid="tao-home-plus"]')
            flow.click('[data-testid="tao-home-context-attach"]')
            before = len(flow.read(FILES)["transport"]["files"])
            file_dialog.run(ctx, dict(kind="open", action="choose", path=str(path), title="打开", trigger='[data-testid="tao-home-file-choose"]'))
            uploaded = flow.wait(lambda: flow.read(FILES),
                                 lambda s: len(s["transport"]["files"]) == before + 1 and s["transport"]["files"][-1]["status"] != "pending",
                                 "Actual document upload did not complete", 120)
            flow.record("upload-" + extension, uploaded)
            if uploaded["credentialInvalid"]:
                raise CredentialInvalid()
            flow.require(uploaded["transport"]["files"][-1]["status"] == "fulfilled" and uploaded["chips"] == 1 and not uploaded["uploadError"],
                         "Actual code/PDF upload failed: " + uploaded["uploadError"])
            flow.send(prompt)
            flow.reply("read-" + extension, 1, marker, check_marker=True)
            flow.require(answer in flow.last_text(), "Real document reply did not reason from the attached content")
            flow.record("content-and-arithmetic-" + extension, dict(freshMarkerRecalled=True, answerCorrect=True))
            flow.screenshot("document-" + extension)
    return "Real DeepSeek document files: " + flow.outcome
