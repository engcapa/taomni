"""Render the reviewed wireframe for the Git clone workspace import dialog.

The image is a design artifact only. It is deliberately low fidelity and does
not claim that any UI or native behavior has been implemented or verified.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
FONT_DIR = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    candidate = FONT_DIR / name
    return ImageFont.truetype(str(candidate) if candidate.exists() else "arial.ttf", size)


REGULAR = font("segoeui.ttf", 16)
SMALL = font("segoeui.ttf", 13)
BOLD = font("segoeuib.ttf", 18)
TITLE = font("segoeuib.ttf", 24)
MONO = font("consola.ttf", 13)

BG = "#10151d"
PANEL = "#171e29"
FIELD = "#0f141c"
BORDER = "#334155"
TEXT = "#e2e8f0"
MUTED = "#94a3b8"
ACCENT = "#3b82f6"
SUCCESS = "#22c55e"


def rect(draw: ImageDraw.ImageDraw, box, fill=PANEL, outline=BORDER, radius=8, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def field(draw: ImageDraw.ImageDraw, box, label: str, value: str, muted: bool = False):
    x1, y1, x2, y2 = box
    draw.text((x1, y1 - 20), label, font=SMALL, fill=MUTED)
    rect(draw, (x1, y1, x2, y2), fill=FIELD)
    draw.text((x1 + 10, y1 + 9), value, font=REGULAR, fill=MUTED if muted else TEXT)


def dialog_idle(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    width, height = 640, 880
    rect(draw, (x, y, x + width, y + height), fill=PANEL, outline="#475569", radius=12, width=2)
    draw.text((x + 24, y + 18), "Clone Git Repository", font=TITLE, fill=TEXT)
    draw.text((x + 24, y + 52), "Create a workspace from GitHub or any Git remote", font=SMALL, fill=MUTED)
    draw.line((x, y + 82, x + width, y + 82), fill=BORDER)

    field(draw, (x + 24, y + 122, x + width - 24, y + 158), "Repository URL", "https://github.com/engcapa/taomni.git")
    draw.text((x + 24, y + 166), "Local path, HTTPS, SSH and scp-like URLs are accepted.", font=SMALL, fill=MUTED)
    field(draw, (x + 24, y + 222, x + 310, y + 256), "Workspace name", "taomni")
    field(draw, (x + 326, y + 222, x + width - 24, y + 256), "Branch", "main")
    field(draw, (x + 24, y + 300, x + width - 118, y + 334), "Location", "C:/Users/engcap/taomni-workspaces")
    rect(draw, (x + width - 104, y + 300, x + width - 24, y + 334), fill="#243244")
    draw.text((x + width - 88, y + 309), "Browse", font=REGULAR, fill=TEXT)
    draw.text((x + 24, y + 350), "Destination", font=SMALL, fill=MUTED)
    draw.text((x + 116, y + 350), "C:/Users/engcap/taomni-workspaces/taomni", font=MONO, fill="#7dd3fc")
    draw.line((x + 24, y + 382, x + width - 24, y + 382), fill=BORDER)

    draw.text((x + 24, y + 398), "Git identity", font=BOLD, fill=TEXT)
    field(draw, (x + 24, y + 444, x + 310, y + 478), "user.name", "engcap")
    field(draw, (x + 326, y + 444, x + width - 24, y + 478), "user.email", "engcap@example.com")
    draw.line((x + 24, y + 500, x + width - 24, y + 500), fill=BORDER)

    draw.text((x + 24, y + 516), "Proxy", font=BOLD, fill=TEXT)
    for index, (label, selected) in enumerate(
        (("Use application proxy", True), ("Custom proxy", False), ("No proxy", False))
    ):
        rx = x + 24 + index * 194
        draw.ellipse((rx, y + 546, rx + 14, y + 560), outline=ACCENT if selected else BORDER, width=2)
        if selected:
            draw.ellipse((rx + 4, y + 550, rx + 10, y + 556), fill=ACCENT)
        draw.text((rx + 20, y + 542), label, font=SMALL, fill=TEXT)
    field(draw, (x + 24, y + 598, x + 310, y + 632), "http.proxy", "http://192.168.0.110:31028", muted=True)
    field(draw, (x + 326, y + 598, x + width - 24, y + 632), "https.proxy", "http://192.168.0.110:31028", muted=True)
    draw.text((x + 24, y + 640), "Prefilled from Settings → Application Proxy; not editable in this mode.", font=SMALL, fill=MUTED)
    draw.line((x + 24, y + 662, x + width - 24, y + 662), fill=BORDER)

    draw.text((x + 24, y + 678), "Authentication", font=BOLD, fill=TEXT)
    field(draw, (x + 24, y + 724, x + 440, y + 758), "Access token", "••••••••••••••••••••", muted=True)
    rect(draw, (x + 456, y + 724, x + width - 24, y + 758), fill="#243244")
    draw.text((x + 472, y + 733), "Show", font=SMALL, fill=TEXT)
    draw.rectangle((x + 24, y + 780, x + 38, y + 794), outline=SUCCESS, width=2)
    draw.text((x + 46, y + 777), "Use the token saved in the vault", font=SMALL, fill=TEXT)
    draw.rectangle((x + 24, y + 806, x + 38, y + 820), outline=BORDER, width=2)
    draw.text((x + 46, y + 803), "Remember in the vault", font=SMALL, fill=MUTED)

    rect(draw, (x + width - 246, y + height - 52, x + width - 136, y + height - 18), fill="#243244")
    draw.text((x + width - 230, y + height - 44), "Cancel", font=REGULAR, fill=TEXT)
    rect(draw, (x + width - 124, y + height - 52, x + width - 24, y + height - 18), fill=ACCENT)
    draw.text((x + width - 100, y + height - 44), "Clone", font=REGULAR, fill="white")


def dialog_progress(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    width, height = 640, 880
    rect(draw, (x, y, x + width, y + height), fill=PANEL, outline="#475569", radius=12, width=2)
    draw.text((x + 24, y + 18), "Clone Git Repository", font=TITLE, fill=TEXT)
    draw.text((x + 24, y + 52), "Cloning — closing this dialog keeps the task running", font=SMALL, fill=MUTED)
    draw.line((x, y + 82, x + width, y + 82), fill=BORDER)

    field(draw, (x + 24, y + 122, x + width - 24, y + 158), "Repository URL", "https://github.com/engcapa/taomni.git", muted=True)
    field(draw, (x + 24, y + 202, x + 310, y + 236), "Workspace name", "taomni", muted=True)
    field(draw, (x + 326, y + 202, x + width - 24, y + 236), "Branch", "main", muted=True)
    field(draw, (x + 24, y + 280, x + width - 24, y + 314), "Destination", "C:/Users/engcap/taomni-workspaces/taomni", muted=True)
    draw.line((x + 24, y + 342, x + width - 24, y + 342), fill=BORDER)

    draw.text((x + 24, y + 364), "Receiving objects 46%", font=BOLD, fill=TEXT)
    draw.text((x + width - 96, y + 364), "46%", font=BOLD, fill=ACCENT)
    rect(draw, (x + 24, y + 394, x + width - 24, y + 406), fill="#0b1220", radius=6)
    draw.rounded_rectangle((x + 24, y + 394, x + 24 + 300, y + 406), radius=6, fill=ACCENT)
    draw.text((x + 24, y + 418), "450 / 980 objects · 1.2 MiB received", font=MONO, fill=MUTED)
    draw.text((x + 24, y + 444), "remote: Counting objects done, compressing done", font=MONO, fill=MUTED)
    rect(draw, (x + 24, y + 480, x + width - 24, y + 536), fill="#1a2433", outline="#2b3b52")
    draw.text((x + 36, y + 489), "Closing this dialog keeps cloning; reopen it from the + menu.", font=SMALL, fill=TEXT)
    draw.text((x + 36, y + 509), "Incomplete files are removed on cancel or failure.", font=SMALL, fill=MUTED)

    draw.text((x + 24, y + 570), "Last progress events", font=BOLD, fill=TEXT)
    for index, line in enumerate(
        (
            "connecting   Cloning into 'taomni'…",
            "counting     remote: Counting objects: 100% (980/980), done.",
            "receiving    Receiving objects: 46% (450/980), 1.2 MiB | 3.1 MiB/s",
        )
    ):
        draw.text((x + 24, y + 602 + index * 22), line, font=MONO, fill=MUTED)

    rect(draw, (x + width - 246, y + height - 52, x + width - 136, y + height - 18), fill="#243244")
    draw.text((x + width - 230, y + height - 44), "Close", font=REGULAR, fill=TEXT)
    rect(draw, (x + width - 124, y + height - 52, x + width - 24, y + height - 18), fill="#7f1d1d")
    draw.text((x + width - 108, y + height - 44), "Cancel clone", font=REGULAR, fill="#fecaca")


def main() -> int:
    canvas = Image.new("RGB", (1360, 980), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((40, 28), "Workspace Git clone import — wireframe v1 (design only)", font=TITLE, fill=TEXT)
    draw.text(
        (40, 62),
        "Entry: Workspaces + menu / workspace switcher / Home clone card. Dialog width 640px, scrollable body.",
        font=SMALL,
        fill=MUTED,
    )
    dialog_idle(draw, 40, 90)
    dialog_progress(draw, 700, 90)
    draw.text((40, 948), "A: idle form with prefilled defaults", font=SMALL, fill=MUTED)
    draw.text((700, 948), "B: reopened dialog while cloning in the background", font=SMALL, fill=MUTED)
    target = ROOT / "git-clone-wireframe.png"
    canvas.save(target)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
