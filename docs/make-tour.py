# Makes docs/tour.gif: the README screenshots (dark theme) one after another, with a caption each.
#   python3 docs/make-tour.py        (needs Pillow and DejaVu Sans; run from the repository root)
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, BAR = 880, 760, 64
BG, FG, ACCENT = (31, 30, 29), (240, 238, 232), (217, 119, 87)
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
SLIDES = [
    ("live-agents-dark.png", "Every session and subagent of the project, live"),
    ("agents-dark.png", "What each agent is doing now, with its todo progress"),
    ("live-dark.png", "Your checklists tick over to In progress as agents work"),
    ("checklist-dark.png", "Project checklists with sections, groups and progress"),
    ("terminal.png", "In the desktop app and in the terminal"),
]


def slide(name, caption):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, BAR], fill=(24, 23, 22))
    d.rectangle([0, BAR - 3, W, BAR], fill=ACCENT)
    d.text((W // 2, BAR // 2 - 2), caption, font=FONT, fill=FG, anchor="mm")
    shot = Image.open(os.path.join(HERE, name)).convert("RGB")
    shot.thumbnail((W - 40, H - BAR - 30), Image.LANCZOS)
    im.paste(shot, ((W - shot.size[0]) // 2, BAR + 15 + (H - BAR - 30 - shot.size[1]) // 2))
    return im


slides = [slide(*s) for s in SLIDES]
frames, durations = [], []
for i, s in enumerate(slides):
    frames.append(s)
    durations.append(2800)
    nxt = slides[(i + 1) % len(slides)]
    for k in range(1, 6):  # cross-fade to the next slide
        frames.append(Image.blend(s, nxt, k / 6))
        durations.append(60)

pal = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for f in frames]
out = os.path.join(HERE, "tour.gif")
pal[0].save(out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True)
print(out, os.path.getsize(out) // 1024, "KB,", sum(durations) / 1000, "s")
