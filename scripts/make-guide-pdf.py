"""The printable copy of the family's guide.

The words live in `src/lib/guide/content.json`, which the /guide page renders too — this only lays the same blocks
out on paper, so the page and the print cannot drift apart. Edit the JSON, then run
`python3 scripts/make-guide-pdf.py` and commit `public/guide.pdf` with the change.
"""

import json
import os
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph,
                                SimpleDocTemplate, Table, TableStyle)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src", "lib", "guide", "content.json")
OUT = os.path.join(HERE, "..", "public", "guide.pdf")

NAVY = colors.HexColor("#1f3a5f")
GREY = colors.HexColor("#555555")
LIGHT = colors.HexColor("#f2f4f7")
BORDER = colors.HexColor("#d9dde3")

ss = getSampleStyleSheet()
TITLE = ParagraphStyle("Title", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=28, textColor=NAVY, spaceAfter=4, alignment=TA_LEFT)
SUB = ParagraphStyle("Sub", parent=ss["Normal"], fontName="Helvetica", fontSize=13, textColor=GREY, leading=18, spaceAfter=20)
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, textColor=NAVY, spaceBefore=16, spaceAfter=7)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, textColor=NAVY, spaceBefore=11, spaceAfter=4)
BODY = ParagraphStyle("Body", parent=ss["Normal"], fontName="Helvetica", fontSize=11, leading=16, spaceAfter=7)
BIG = ParagraphStyle("Big", parent=BODY, fontSize=12.5, leading=18)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=9, leading=12, textColor=GREY)
NOTE = ParagraphStyle("Note", parent=BODY, backColor=LIGHT, borderColor=BORDER, borderWidth=0.5, borderPadding=8,
                      leftIndent=2, spaceBefore=6, spaceAfter=10)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=10, leading=14, spaceAfter=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")

W = letter[0] - 1.8 * inch

# Sections that read better starting on a fresh page: the ones whose table is the thing somebody prints and keeps.
BREAK_BEFORE = {"finding", "trips", "sharing", "fixing", "ai"}


def rich(text):
    """`**bold**` and `_italic_`, the two rules the guide's words use, in reportlab's own inline markup."""
    out = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    return re.sub(r"_([^_]+)_", r"<i>\1</i>", out)


def P(t, s=BODY):
    return Paragraph(rich(t), s)


def bullets(items, numbered=False):
    return ListFlowable([ListItem(P(i), leftIndent=14 if numbered else 12) for i in items],
                        bulletType="1" if numbered else "bullet", start=None if numbered else "•",
                        leftIndent=18 if numbered else 16, bulletFontSize=9, spaceAfter=8)


def table(columns, rows):
    widths = [1.7 * inch, W - 1.7 * inch] if len(columns) == 2 else [W / len(columns)] * len(columns)
    if len(columns) == 3:
        widths = [1.1 * inch, W - 3.0 * inch, 1.9 * inch]
    data = [[Paragraph(rich(c), CELLB) for c in columns]] + [[Paragraph(rich(c), CELL) for c in row] for row in rows]
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("TEXTCOLOR", (0, 0), (-1, 0), NAVY),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def flow(block, body=BODY):
    kind = block["kind"]
    if kind == "p":
        return [P(block["text"], body)]
    if kind == "h3":
        return [P(block["text"], H2)]
    if kind == "small":
        return [P(block["text"], SMALL)]
    if kind == "note":
        return [P(block["text"], NOTE)]
    if kind == "bullets":
        return [bullets(block["items"])]
    if kind == "steps":
        return [bullets(block["items"], numbered=True)]
    if kind == "table":
        return [table(block["columns"], block["rows"])]
    raise SystemExit(f"unknown block kind in the guide: {kind}")


def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(0.9 * inch, 0.72 * inch, letter[0] - 0.9 * inch, 0.72 * inch)
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(GREY)
    canvas.drawString(0.9 * inch, 0.55 * inch, "Family Album — how to use it")
    canvas.drawRightString(letter[0] - 0.9 * inch, 0.55 * inch, f"page {doc.page}")
    canvas.restoreState()


with open(SRC, encoding="utf-8") as f:
    guide = json.load(f)

S = [P(guide["title"], TITLE), P(guide["subtitle"], SUB)]
for block in guide["intro"]:
    S += flow(block, BIG)
S += [P("What is in this guide", H1),
      bullets([f"{n}. {s['heading']}" for n, s in enumerate(guide["sections"], 1)])]

for n, section in enumerate(guide["sections"], 1):
    if section["id"] in BREAK_BEFORE:
        S.append(PageBreak())
    heading = P(f"{n}. {section['heading']}", H1)
    blocks = [f for block in section["blocks"] for f in flow(block)]
    # The closing section is short enough to be stranded alone on a last page; keep it whole wherever it lands.
    S += [KeepTogether([heading] + blocks)] if section is guide["sections"][-1] else [heading] + blocks

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                        topMargin=0.8 * inch, bottomMargin=0.9 * inch,
                        title="Family Album — how to use it", author="Family Album",
                        subject="A plain guide to using the family photo album")
doc.build(S, onFirstPage=on_page, onLaterPages=on_page)
print("wrote", OUT)
