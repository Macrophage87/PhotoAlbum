"""The family's own guide to the album, in the plainest words that are still true.

Written for whoever in the family is least sure about computers: short sentences, one idea at a time, no jargon
that is not explained on the spot. It is deliberately not the setup guide — nobody reading this installs anything.

Run `python3 scripts/make-guide-pdf.py` after editing, and commit the PDF with the change. It is written into
`public/` so the album serves it at /guide.pdf and the Help link in the menu opens it.
"""

import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "guide.pdf")

NAVY = colors.HexColor("#1f3a5f")
ACCENT = colors.HexColor("#b3392b")
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


def P(t, s=BODY):
    return Paragraph(t, s)


def note(t):
    return Paragraph(t, NOTE)


def bullets(items):
    return ListFlowable([ListItem(P(i), leftIndent=12) for i in items], bulletType="bullet", start="•",
                        leftIndent=16, bulletFontSize=9, spaceAfter=8)


def steps(items):
    return ListFlowable([ListItem(P(i), leftIndent=14) for i in items], bulletType="1", leftIndent=18, spaceAfter=8)


def table(rows, widths):
    data = [[Paragraph(c, CELLB if i == 0 else CELL) for c in row] for i, row in enumerate(rows)]
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


S = []

# ---------- cover ----------
S += [P("Family Album", TITLE),
      P("How to use it. In very plain words.", SUB),
      P("This is our family's photo album. It lives on our own computer, not on anybody else's. "
        "Nothing in it is for sale, and nobody sees it unless we send it to them.", BIG),
      note("<b>The one thing to remember:</b> you cannot break it. Nothing you press deletes a photograph for good. "
           "If something looks wrong, say so — it can be put back."),
      P("What is in this guide", H1),
      bullets([
          "Getting in (there is no password)",
          "Looking at photographs",
          "Finding one particular photograph",
          "Adding your own",
          "Trips, collections and outings — what they are",
          "People and pets",
          "Sending a photograph to somebody",
          "Fixing something that is wrong",
          "What the computer writes by itself",
          "Words this album uses",
      ])]

# ---------- 1 ----------
S += [PageBreak(),
      P("1. Getting in", H1),
      P("There is no password to remember. That is on purpose — passwords get forgotten, written on paper, and reused.", BODY),
      steps([
          "Go to the album's web address. Somebody in the family will have sent it to you.",
          "Type your email address and press the button.",
          "Look in your email. There will be a message with a link in it.",
          "Press that link. You are in.",
      ]),
      P("The link only works once, and only for about fifteen minutes. That is what keeps it safe. "
        "If you take too long, just ask for another one.", BODY),
      note("<b>No email arrived?</b> Only people the family has invited can get in, so the album will not send a link "
           "to an address it does not know. Ask whoever runs the album to invite you. Also look in your junk folder."),
      P("Once you are in, it remembers you on that phone or computer for a few months. You will not have to do this often.", BODY)]

# ---------- 2 ----------
S += [P("2. Looking at photographs", H1),
      P("Open a trip and you land on its <b>timeline</b>: the days it happened, in order, top to bottom. "
        "That is how people remember a holiday — the day we got there, the day of the boat, the last morning — "
        "so that is what the album shows first.", BODY),
      P("On a computer", H2),
      P("Down the left there is a list of every day. Press one to jump to it. The day you are looking at is marked as you scroll.", BODY),
      P("On a phone", H2),
      P("There is no room for the list, so the date at the top of the screen does the job. Press the date and every day "
        "appears; press one to go there.", BODY),
      P("Press any photograph to see it big. Press it again to see it at full size. The arrow keys, or a swipe, move to the next one.", BODY),
      P("Other ways to look", H2),
      table([
          ["Where", "What it shows you"],
          ["Timeline", "The days, in order. This is the usual way."],
          ["Map", "Where photographs were taken. Useful for “where was that beach?”"],
          ["Activities", "The walks, rides and outings, with how far and how long."],
          ["Photos", "All of them in a plain grid, newest first."],
          ["Overview", "A few numbers and a handful of photographs picked at random."],
      ], [1.5 * inch, W - 1.5 * inch])]

# ---------- 3 ----------
S += [PageBreak(),
      P("3. Finding one particular photograph", H1),
      P("Every timeline, every map and every grid has a search box. Type a word or two and press <b>Search</b>.", BODY),
      P("The good part: it does not send you to a separate list of results. It narrows the page you are already on. "
        "So the photograph you were after comes back still sitting under the day it was taken, with that day around it.", BODY),
      P("What to type", H2),
      bullets([
          "What is in it: <i>lobster</i>, <i>cake</i>, <i>lighthouse</i>, <i>snow</i>",
          "What was happening: <i>birthday</i>, <i>hiking</i>, <i>christmas</i>",
          "Something written in the picture: a banner, a sign, writing on the back of an old print",
          "A name somebody typed in the notes",
      ]),
      P("More ways to narrow", H2),
      P("Under the search box there is <b>More ways to narrow</b>. Press it and you can also ask for:", BODY),
      table([
          ["Question", "What it means"],
          ["Uploaded by", "Who put it into the album. Usually, but not always, who took it."],
          ["Who is in it", "A person or a pet. Choose two names and you get the ones they are <i>both</i> in."],
          ["Part of the trip", "Only photographs from one walk or outing."],
          ["Year", "Only that year."],
          ["Type", "Photographs, video clips, YouTube links, or 3D scans."],
      ], [1.5 * inch, W - 1.5 * inch]),
      note("A narrowed page has its own web address. You can save it, or send it to somebody else in the family, "
           "and they see the same thing.")]

# ---------- 4 ----------
S += [P("4. Adding your own photographs", H1),
      steps([
          "Press <b>Upload</b> in the menu at the top.",
          "Choose the photographs, or drag them onto the page.",
          "Wait. Each one says when it is done.",
      ]),
      P("Big ones take a few seconds each. You can keep using the album while they go up.", BODY),
      P("Where do they end up?", H2),
      P("The album reads the date the camera wrote and puts each photograph on the trip that was happening then. "
        "If no trip matches, it waits in <b>Photos without a trip</b> until somebody files it.", BODY),
      note("<b>Photographs from an Android phone often arrive with no place on them.</b> That is the phone, not the album: "
           "it removes the location from the copy it hands over. The map can still be filled in afterwards — see section 8.")]

# ---------- 5 ----------
S += [PageBreak(),
      P("5. Trips, collections and outings", H1),
      P("Three words the album uses. They are simpler than they sound.", BODY),
      table([
          ["Word", "What it is", "Think of it as"],
          ["Trip", "A stretch of days in one place. A photograph is on one trip, or none.", "A holiday"],
          ["Collection", "A gathering of photographs from anywhere, for any reason. A photograph can be in many.", "A scrapbook"],
          ["Activity", "One outing inside a trip: a walk, a ride, a paddle, an afternoon.", "A day out"],
      ], [1.1 * inch, W - 3.0 * inch, 1.9 * inch]),
      P("Activities: why the distances are there", H2),
      P("If somebody imported a trace from a watch or a phone, the outing knows how far it went, how long it took "
        "and how much climbing there was. The photographs taken during those hours are gathered onto it by themselves.", BODY),
      P("Sometimes the album gets that wrong — two people did two different things that afternoon, and a clock cannot "
        "tell which. To fix it, open the outing, press <b>Select photos</b>, tick the ones that do not belong, and press "
        "<b>Take off this activity</b>. They stay on the trip, back under their own day. Nothing is deleted.", BODY),
      P("Ask the album to describe an outing", H2),
      P("On an outing's page there is <b>Write a description</b>. It looks at a few of the photographs and at how far "
        "the walk went, and writes a short paragraph. You can change the words afterwards. It asks first, because it "
        "sends those photographs to a computer service to do it.", BODY)]

# ---------- 6 ----------
S += [P("6. People and pets", H1),
      P("The album can keep track of who is in a photograph, so you can ask for “the ones with Mum in them”.", BODY),
      P("Two separate things, on purpose", H2),
      table([
          ["This", "Means"],
          ["Tagging somebody", "You point at a face and say who it is. Anyone who can edit the photograph can do this. "
                               "It does not switch anything on."],
          ["Recognising somebody", "The album learns a face and looks for it in new photographs. This needs that "
                                   "person's agreement, and only an admin can turn it on."],
          ["Using a name in descriptions", "The album may use the name when it writes about a photograph. Also their "
                                           "choice, also separate. Children are never named."],
      ], [1.9 * inch, W - 1.9 * inch]),
      P("This is fussier than it needs to be for a family album, and that is deliberate: a face is not the same kind of "
        "thing as a caption, and somebody may be happy to be named without wanting to be recognised.", BODY),
      P("Pets work the same way, without the agreement — a dog cannot consent, and does not need to.", BODY)]

# ---------- 7 ----------
S += [PageBreak(),
      P("7. Sending a photograph to somebody", H1),
      P("Everything in the album is private until you decide otherwise. There are three ways to let somebody outside "
        "the family see something.", BODY),
      table([
          ["Way", "Who can see it"],
          ["Private", "Only the family. This is how everything starts."],
          ["A secret link", "Anyone you send the link to. They do not need to sign in. Nobody else can find it."],
          ["Public", "Anybody at all, including strangers who find it by chance."],
      ], [1.5 * inch, W - 1.5 * inch]),
      P("You can share a whole trip, a collection, or just one outing. Press <b>Share</b>, and the link is there ready "
        "to copy. Paste it into a message and it carries the title and a picture with it.", BODY),
      note("<b>A link shows everything in that thing.</b> A shared trip shows all its photographs — and, if there are "
           "traces from a watch or phone, the paths they recorded. That is a record of where people were and when. "
           "Share an outing on its own if that is all you meant to send."),
      P("Changed your mind? Press <b>New link</b> and the old one stops working straight away, or "
        "<b>Stop sharing</b> to close it altogether.", BODY)]

# ---------- 8 ----------
# Its own page: the table of fixes is the one page somebody prints and keeps, and splitting it strands a row.
S += [PageBreak(),
      P("8. Fixing something that is wrong", H1),
      table([
          ["What is wrong", "What to do"],
          ["Wrong date, so it is under the wrong day",
           "Open the photograph and change the date. On the timeline you can pick up a whole day at once — press "
           "<b>Select photos</b>, then <b>Select this day</b> — which is the usual fix for a box of old scans that all "
           "landed on the day somebody scanned them."],
          ["No place on the map",
           "Open the photograph and use <b>Set a place</b>: press the map, or type an address. You can do a whole "
           "selection at once. Or drag photographs straight onto the map."],
          ["On the wrong outing",
           "Open the outing, <b>Select photos</b>, <b>Take off this activity</b>. It stays on the trip."],
          ["On the wrong trip, or no trip",
           "Select it in any grid and use the bulk actions to put it on the right one."],
          ["A photograph that should not be there",
           "Press <b>Trash</b> and say why. It leaves the album at once but is not gone: an admin can put it back. "
           "Anyone in the family can do this."],
          ["The same photograph twice",
           "If they are the very same file, the album already folded them into one. If they are two similar shots, "
           "trash the one you do not want."],
          ["A description that is wrong or unkind",
           "Just edit it. What you write is yours and the album will not overwrite it."],
      ], [1.9 * inch, W - 1.9 * inch])]

# ---------- 9 ----------
S += [PageBreak(),
      P("9. What the computer writes by itself", H1),
      P("The album can ask an AI helper to describe photographs, so they can be found by searching for what is in them. "
        "This is off unless somebody turned it on, and it is worth knowing what it does.", BODY),
      bullets([
          "It writes a title, a caption, a description and a list of search words.",
          "It is told the names of people the family has agreed to name. It is never told a child's name.",
          "It never sees faces as faces: no face data of any kind is sent to it.",
          "Anything you write yourself is left alone. It only replaces its own words.",
          "A trip, a collection or a single photograph can be kept out of it entirely.",
      ]),
      P("If a description says something you do not like, change it. Your words win.", BODY),
      P("The <b>Graph</b> page is a different trick: it draws photographs that look alike near each other. "
        "It is a good way to find the four nearly identical shots of the same puddle.", BODY)]

# ---------- 10 ----------
S += [P("10. Words this album uses", H1),
      table([
          ["Word", "What it means here"],
          ["Timeline", "Photographs laid out by the day they were taken."],
          ["Trip", "A stretch of days in one place."],
          ["Collection", "A gathering of photographs chosen by hand."],
          ["Activity", "One outing inside a trip."],
          ["Track", "A path recorded by a watch or a phone."],
          ["Tag", "Pointing at somebody in a photograph and saying who they are."],
          ["Trash", "Out of the album, but not gone. An admin can put it back."],
          ["Member", "Somebody in the family who can sign in."],
          ["Admin", "A member who can also invite people and change the settings."],
          ["Share link", "A secret web address that lets somebody see one thing without signing in."],
      ], [1.5 * inch, W - 1.5 * inch]),
      Spacer(1, 14),
      KeepTogether([P("Still stuck?", H1),
                    P("Ask whoever set the album up. It is one of the family, not a company, and there is no support queue. "
        "Tell them what you pressed and what happened — that is usually enough to find it.", BODY),
                    Spacer(1, 10),
                    P("This guide covers using the album. Installing and running it is a different document, "
                      "SETUP.pdf, and nobody needs it to look at photographs.", SMALL)])]

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                        topMargin=0.8 * inch, bottomMargin=0.9 * inch,
                        title="Family Album — how to use it", author="Family Album",
                        subject="A plain guide to using the family photo album")
doc.build(S, onFirstPage=on_page, onLaterPages=on_page)
print("wrote", OUT)
