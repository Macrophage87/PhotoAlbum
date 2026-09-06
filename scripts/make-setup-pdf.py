from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Preformatted, KeepTogether, ListFlowable, ListItem)

OUT = "/home/user/PhotoAlbum/docs/SETUP.pdf"

NAVY = colors.HexColor("#1f3a5f")
ACCENT = colors.HexColor("#b3392b")
GREY = colors.HexColor("#555555")
LIGHT = colors.HexColor("#f2f4f7")
CODEBG = colors.HexColor("#f7f7f5")
BORDER = colors.HexColor("#d9dde3")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=18, textColor=NAVY, spaceBefore=14, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=13, textColor=NAVY, spaceBefore=12, spaceAfter=5)
BODY = ParagraphStyle("Body", parent=ss["Normal"], fontName="Helvetica", fontSize=10, leading=14, spaceAfter=6)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.5, leading=11, textColor=GREY)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=9, leading=12, spaceAfter=0)
CELLV = ParagraphStyle("CellV", parent=CELL, fontSize=8, leading=10, splitLongWords=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")
CODE = ParagraphStyle("Code", parent=ss["Code"], fontName="Courier", fontSize=8.5, leading=11, backColor=CODEBG,
                      borderColor=BORDER, borderWidth=0.5, borderPadding=6, leftIndent=4, spaceBefore=4, spaceAfter=10)
NOTE = ParagraphStyle("Note", parent=BODY, backColor=LIGHT, borderColor=BORDER, borderWidth=0.5, borderPadding=6,
                      leftIndent=4, spaceBefore=4, spaceAfter=10)
TITLE = ParagraphStyle("Title", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=26, textColor=NAVY, spaceAfter=6, alignment=TA_LEFT)
SUB = ParagraphStyle("Sub", parent=BODY, fontSize=12, textColor=GREY, spaceAfter=18)

def P(t, s=BODY): return Paragraph(t, s)
def code(t): return Preformatted(t.strip("\n"), CODE)
def note(t): return Paragraph(t, NOTE)
def bullets(items):
    return ListFlowable([ListItem(P(i), leftIndent=12) for i in items], bulletType="bullet", start="•", leftIndent=14, bulletFontSize=8, spaceAfter=6)
def steps(items):
    return ListFlowable([ListItem(P(i), leftIndent=14) for i in items], bulletType="1", leftIndent=16, spaceAfter=6)
def table(rows, widths, first=None):
    data = [[Paragraph(c, CELLB) for c in rows[0]]] + [[Paragraph(c, first if (first and j==0) else CELL) for j,c in enumerate(r)] for r in rows[1:]]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), LIGHT),
        ("LINEBELOW", (0,0), (-1,0), 0.8, NAVY),
        ("GRID", (0,1), (-1,-1), 0.3, BORDER),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 5), ("RIGHTPADDING", (0,0), (-1,-1), 5),
        ("TOPPADDING", (0,0), (-1,-1), 4), ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    t.spaceAfter = 10
    return t

def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8); canvas.setFillColor(GREY)
    canvas.drawString(0.9*inch, 0.55*inch, "Family Album  |  Setup Guide")
    canvas.drawRightString(letter[0]-0.9*inch, 0.55*inch, f"Page {doc.page}")
    canvas.setStrokeColor(BORDER); canvas.line(0.9*inch, 0.7*inch, letter[0]-0.9*inch, 0.7*inch)
    canvas.restoreState()

W = letter[0] - 1.8*inch
S = []

# ---------- Cover / intro ----------
S += [P("Family Album", TITLE), P("Setup and operations guide for the self-hosted trip photo album", SUB)]
S += [P("This guide explains what the Family Album application is, how to install and run it with Docker, how to configure "
        "email, storage and maps, how to bring family members on board, and how to use the day-to-day features such as "
        "trips, photo uploads, GPS track imports, themes and sharing. It ends with a development setup, backup advice and troubleshooting.")]

S += [P("Contents", H2), bullets([
    "1. What the application does",
    "2. Requirements",
    "3. Quick start with Docker",
    "4. Configuration reference (.env)",
    "5. Signing in and inviting family",
    "6. Using the album: trips, uploads, activities, tracks, themes, sharing",
    "7. Running behind a reverse proxy",
    "8. Backups and upgrades",
    "9. Development setup and tests",
    "10. Troubleshooting",
])]

# ---------- 1 ----------
S += [P("1. What the application does", H1),
      P("Family Album is a private web app for organising family trip photos. Photos belong to a <b>trip</b>, and within a trip "
        "to an <b>activity</b> (a hike, a bike ride, a boat tour, a meal). Everything can be browsed on a <b>timeline</b> grouped by day "
        "and on a <b>map</b>. GPS tracks from a watch, bike computer or Google location history give activities a route and fitness "
        "statistics, and can place photos that have no GPS data of their own."),
      bullets([
        "<b>Automatic organisation.</b> Uploaded photos land on the right trip by the date they were taken, and on the right activity by time of day.",
        "<b>Any camera or phone.</b> JPEG, PNG, WebP and iPhone HEIC are accepted. Originals are kept; web-sized WebP versions are generated for display.",
        "<b>Correct times.</b> Camera clocks are reconciled using the EXIF time-zone offset, the GPS position, or the trip's time zone. A one-click fix handles cameras left in the wrong zone.",
        "<b>Tracks and stats.</b> Import GPX, Garmin FIT, or Google Timeline exports. Activities show distance, moving time, elevation, pace or speed, heart rate, cadence, power and calories, with charts linked to the map.",
        "<b>Photos placed from tracks.</b> A photo taken during a hike without GPS is positioned by interpolating along the track.",
        "<b>Themes.</b> Each trip gets a look: lighthouse coast, Scottish highlands, Everglades swamp, desert canyon, alpine, or classic.",
        "<b>Sharing.</b> Trips are private by default, can be shared by a secret link, or made public.",
        "<b>Photo links.</b> Photos can be marked as the same scene, before/after, panorama parts, or related.",
        "<b>Passwordless sign-in.</b> Family members sign in with an emailed link. An admin invites them.",
      ])]

S += [P("How it is built", H2),
      P("The app is a single Next.js server with a PostgreSQL database and a folder for photos. Background work "
        "(processing uploads, parsing track files, geotagging) runs in a job queue stored in Postgres, so there is nothing else to run."),
      table([
        ["Component", "Technology", "Role"],
        ["Web app", "Next.js 16, React 19, TypeScript", "Pages, uploads, API routes"],
        ["Database", "PostgreSQL 16 with Prisma 7", "Trips, activities, photos, tracks, users"],
        ["Photo storage", "Local folder (Docker volume)", "Originals plus generated thumbnails"],
        ["Jobs", "pg-boss (in the Postgres database)", "Photo processing, track imports, geotagging"],
        ["Images", "sharp, exifr, heic-convert", "EXIF reading, resizing, HEIC conversion"],
        ["Maps", "MapLibre GL with OpenStreetMap tiles", "Clustered photo markers and track lines"],
        ["Email", "Nodemailer over SMTP", "Sign-in and invite links"],
      ], [1.2*inch, 2.4*inch, W-3.6*inch])]

# ---------- 2 ----------
S += [P("2. Requirements", H1),
      bullets([
        "A machine that runs <b>Docker</b> and <b>Docker Compose v2</b>: a home server, NAS, Raspberry Pi 4 or better, or a small VPS. 2 GB of RAM is comfortable; HEIC conversion is the heaviest task.",
        "Disk space for photos. Originals are kept, so budget for the size of your library plus roughly 15% for renditions.",
        "An <b>SMTP account</b> for sending sign-in emails (any provider: Gmail app password, Fastmail, Mailgun, Postmark, your ISP). Optional for testing; links can be read from the log instead.",
        "Optional: a domain name and a reverse proxy with HTTPS if you want to reach the album from outside your home network.",
      ])]

# ---------- 3 ----------
S += [P("3. Quick start with Docker", H1),
      steps([
        "Get the code onto the server, either by cloning the repository or by copying the project folder.",
        "Create your configuration file from the template and edit it. At minimum set <b>ADMIN_EMAIL</b> to your own address.",
        "Build and start the stack. The first build takes a few minutes.",
        "Open the site, enter the admin email, and follow the sign-in link.",
      ]),
      code("""
git clone https://github.com/Macrophage87/PhotoAlbum.git
cd PhotoAlbum
cp .env.example .env
nano .env                 # set ADMIN_EMAIL, and SMTP_* for real email
docker compose up --build -d
"""),
      P("The stack has two services. <b>db</b> is PostgreSQL 16 with its data in the <b>pgdata</b> volume. <b>app</b> is the web server, "
        "with photos in the <b>photos</b> volume mounted at /data/photos. On every start the app applies pending database migrations "
        "before serving, so upgrades need no manual database step."),
      P("Browse to <b>http://&lt;server&gt;:3000</b>. Change the host port with APP_PORT in .env if 3000 is taken."),
      P("Reading the sign-in link without email", H2),
      P("If SMTP_HOST is left empty, sign-in and invite links are printed to the container log instead of being sent. "
        "This is fine for first setup and for a purely local install."),
      code("""docker compose logs -f app | grep "auth/verify" """),
      P("Loading demo data", H2),
      P("A seed script creates a sample lighthouse-themed trip in Acadia, Maine with a hike, its track and stats, and two sample photos, "
        "one of which is positioned from the track. It is a quick way to see every feature working."),
      code("""docker compose exec app node_modules/.bin/tsx prisma/seed.ts"""),
      P("Useful commands", H2),
      code("""
docker compose ps                  # service status
docker compose logs -f app         # follow app log
docker compose restart app         # restart the web app
docker compose down                # stop (volumes are kept)
docker compose pull && docker compose up --build -d   # rebuild after updating the code
""")]

# ---------- 4 ----------
S += [P("4. Configuration reference (.env)", H1),
      P("All settings live in the .env file next to docker-compose.yml. The compose file also reads POSTGRES_USER, POSTGRES_PASSWORD, "
        "POSTGRES_DB and APP_PORT from it. DATABASE_URL and PHOTO_STORAGE_ROOT are set by the compose file for the container, so you "
        "only need to change them for a non-Docker install."),
      table([
        ["Variable", "Default", "Purpose"],
        ["APP_URL", "http://localhost:3000", "Public URL of the site. Used in every emailed link and in redirects. Set it to your real address (with https) when behind a proxy."],
        ["ADMIN_EMAIL", "you@example.com", "The first person to sign in with this address becomes an admin. Also allowed to sign in before any invites exist."],
        ["SMTP_HOST", "(empty)", "Mail server hostname. Leave empty to log links instead of sending mail."],
        ["SMTP_PORT", "587", "587 for STARTTLS, 465 for implicit TLS."],
        ["SMTP_USER / SMTP_PASS", "(empty)", "Mail server credentials."],
        ["SMTP_SECURE", "false", "Set true when using port 465."],
        ["SMTP_FROM", "Family Album<br/>&lt;album@example.com&gt;", "Sender shown in emails. Many providers require it to match the account."],
        ["POSTGRES_USER / _PASSWORD / _DB", "photoalbum", "Database credentials used by both containers. Change the password on an internet-facing host."],
        ["APP_PORT", "3000", "Host port published by Docker."],
        ["STORAGE_DRIVER", "local", "Storage backend. Only local is implemented; the code has an interface for adding S3 later."],
        ["PHOTO_STORAGE_ROOT", "/data/photos", "Where originals and renditions are written (inside the container)."],
        ["MAX_UPLOAD_BYTES", "104857600 (100 MB)", "Largest single photo accepted."],
        ["MAX_IMPORT_BYTES", "2147483648 (2 GB)", "Largest track or Google export file accepted."],
        ["RUN_WORKER", "true", "Run background jobs inside the web process. Set false only if you run a separate worker container."],
        ["NEXT_PUBLIC_TILE_URL", "(empty, uses OpenStreetMap)", "Raster tile template for the map, e.g. from MapTiler or Stadia."],
        ["NEXT_PUBLIC_MAP_STYLE_URL", "(empty)", "Full MapLibre style JSON URL. Overrides the tile URL."],
      ], [1.85*inch, 1.25*inch, W-3.1*inch], first=CELLV),
      note("<b>Gmail example.</b> SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_SECURE=false, SMTP_USER=your address, "
           "SMTP_PASS=an App Password generated in your Google account security settings (normal passwords are rejected), "
           "SMTP_FROM=the same address. Restart the app after changing .env: <font face='Courier'>docker compose up -d</font>.")]

# ---------- 5 ----------
S += [P("5. Signing in and inviting family", H1),
      P("There are no passwords. A person types their email on the sign-in page and receives a link that is valid for 15 minutes "
        "and can be used once. The resulting session lasts 90 days on that browser."),
      P("Who can sign in", H2),
      bullets([
        "The address in ADMIN_EMAIL, always. The first sign-in with it creates the admin account.",
        "Anyone who already has an account.",
        "Anyone with a pending invite for their address.",
        "Everyone else is told the address is not recognised; no account is created.",
      ]),
      P("Inviting members", H2),
      steps([
        "Sign in as the admin and open <b>Admin</b> from the top navigation (the /admin page).",
        "Enter the relative's email address and choose Member or Admin. An invite email is sent (or logged when SMTP is not set up).",
        "The relative opens the invite link, which sends them a sign-in link for that address. From then on they simply sign in with their email.",
        "The Admin page lists members and pending invites. From there you can change roles, revoke an invite, or remove a member.",
      ]),
      P("Members can create trips, upload photos, edit anything, and share trips. Admins can additionally manage members. "
        "Every signed-in member sees every trip; the album is a shared family space, not per-user galleries.")]

# ---------- 6 ----------
S += [P("6. Using the album", H1),
      P("Creating a trip", H2),
      P("Choose <b>New trip</b> on the front page. Give it a title, start and end dates, the local time zone of the destination, and a theme. "
        "The date range matters: it is how uploaded photos are matched to the trip, and how Google location exports are filtered. "
        "The time zone is used when a photo's camera did not record one and when grouping days on the timeline."),
      P("Uploading photos", H2),
      bullets([
        "Use the <b>Upload</b> button inside a trip's Photos tab, or the global Upload page. Drag and drop or pick files; several upload at once.",
        "Each photo is processed in the background: EXIF date, GPS and camera details are read, the image is rotated correctly, and thumbnail and medium WebP renditions are made. Tiles show a spinner until ready.",
        "A photo uploaded from a trip page is attached to that trip. Uploaded from the global page, it is matched to whichever trip's dates contain the day it was taken. If several trips overlap, it stays unassigned and shows a 'needs trip' badge until you assign it.",
        "If the photo's time falls inside an activity's window on that trip, it is attached to the activity too.",
        "The photo detail page shows EXIF data, lets you edit the caption, move the photo to a trip or activity, shift the time zone if the camera was set wrong, set it as the trip cover, and link it to other photos.",
        "In the gallery, select several photos for bulk actions: assign to an activity, set cover, or delete.",
      ]),
      note("<b>iPhone HEIC photos</b> work, but conversion is slow (a few seconds each). If you prefer, set the iPhone camera to "
           "'Most Compatible' so it saves JPEG. Renditions are always WebP, so browsers never need HEIC support."),
      P("Activities", H2),
      P("An activity is anything you did within a trip: hike, bike, run, kayak, drive, boat, sightseeing, food, or other. Create one by hand "
        "from the trip's Activities tab with a title, type and time window, or let a FIT or GPX import create it. Photos whose time falls inside "
        "the window are attached automatically and shown inside the activity's card on the timeline."),
      P("Importing GPS tracks", H2),
      P("Open the trip's <b>Import</b> page and upload a file. The import runs in the background and reports what it created."),
      table([
        ["Source", "What to upload", "Result"],
        ["Garmin, Wahoo, Strava, Komoot, AllTrails, phone apps", ".gpx or .fit file (export the activity from the app or Garmin Connect)",
         "An activity with route, statistics and charts. Sport is detected from FIT files. Photos in its time window are attached and, if they lack GPS, positioned from the track."],
        ["Google Maps Timeline (on the phone)", "Google Maps > profile picture > Your Timeline > (three dots) > Location and privacy settings > Export Timeline data. Upload the resulting Timeline.json.",
         "One location trace per day of the trip, drawn dashed on the map. No activity is created."],
        ["Google Takeout (older exports)", "Records.json, or the monthly Semantic Location History JSON files.", "Same as above."],
      ], [1.5*inch, 2.4*inch, W-3.9*inch]),
      P("Only points inside the trip's dates are imported, so uploading a whole multi-year export is safe; the app streams the file rather "
        "than loading it into memory. Statistics computed from a track: distance, moving and elapsed time, elevation gain and loss, average "
        "and maximum speed or pace, heart rate, cadence, power and normalized power, and calories. Values recorded by a Garmin device in the "
        "FIT file take precedence over computed ones so they match what the watch showed."),
      P("Timeline and map", H2),
      bullets([
        "The trip <b>Timeline</b> groups photos and activities by local day, with a day list on the side for jumping around. Photos taken during an activity appear inside its card next to a small route drawing and key stats.",
        "The trip <b>Map</b> shows clustered photo markers and colour-coded track lines. Click a cluster to zoom in, a marker to preview and open the photo, a track to open the activity.",
        "The <b>activity page</b> shows the full-size map, the stat grid, and elevation, speed, heart-rate and power charts. Moving the mouse along a chart moves a marker along the route.",
        "The global <b>Map</b> and <b>Timeline</b> pages in the top navigation show every trip together, each keeping its own theme colours.",
      ]),
      P("Themes", H2),
      P("Pick a theme when creating a trip or later in its Settings. A theme sets the palette, fonts, illustrated header art, "
        "map marker shape and decorative motif for that trip's pages, including the shared and public views."),
      table([
        ["Theme", "Feel", "Suggested for"],
        ["Classic", "Neutral slate and blue", "Anything"],
        ["Lighthouse Coast", "Navy, fog white, red and white stripes, sea glass", "Maine, coastal New England, the Pacific coast"],
        ["Highlands", "Heather purple, peat brown, moss green, mist", "Scotland, Ireland, moorland"],
        ["Swamp", "Deep green, cypress brown, egret white, sunset orange", "Everglades, bayou, wetlands"],
        ["Desert Canyon", "Terracotta, sandstone, sage, turquoise sky", "Utah, Arizona, the Southwest"],
        ["Alpine", "Ice blue, granite grey, pine green, snow", "The Alps, Rockies, ski trips"],
      ], [1.3*inch, 2.6*inch, W-3.9*inch]),
      P("Sharing a trip", H2),
      P("Each trip has a visibility setting in its Settings page."),
      bullets([
        "<b>Private</b> (default): only signed-in family members can see it.",
        "<b>Anyone with the link</b>: a secret link is generated. Relatives without accounts can view the photos, activities, timeline and map, but cannot edit. The link can be rotated at any time, which immediately disables the old one.",
        "<b>Public</b>: anyone can browse the trip without signing in and it appears on the front page for visitors.",
      ]),
      note("<b>Privacy.</b> A shared or public trip exposes every photo, activity and location trace on that trip, which reveals where people "
           "were and when. Keep photos you would not share on a private trip, and rotate a link if it spreads further than intended.")]

# ---------- 7 ----------
S += [P("7. Running behind a reverse proxy", H1),
      P("To reach the album from outside your network, put it behind a reverse proxy that terminates HTTPS (Caddy, nginx, Traefik, or your "
        "NAS's built-in proxy). Two things need attention:"),
      bullets([
        "Set <b>APP_URL</b> in .env to the public address, for example https://album.example.com, so emailed links and redirects use it.",
        "Raise the proxy's request body limit. Photos are up to 100 MB by default and Google exports can be far larger. The app-side caps are MAX_UPLOAD_BYTES and MAX_IMPORT_BYTES.",
      ]),
      P("Caddy example (automatic HTTPS):"),
      code("""
album.example.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 2GB
    }
}
"""),
      P("nginx example:"),
      code("""
server {
    listen 443 ssl;
    server_name album.example.com;
    client_max_body_size 2g;
    proxy_read_timeout 600s;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
"""),
      P("When exposed to the internet, also change POSTGRES_PASSWORD from the default, and consider not publishing the database port at all "
        "(the default compose file does not).")]

# ---------- 8 ----------
S += [P("8. Backups and upgrades", H1),
      P("Two things hold all your data: the <b>pgdata</b> volume (database) and the <b>photos</b> volume (originals and renditions). "
        "Back up both. The photos volume is the irreplaceable one."),
      code("""
# database dump
docker compose exec db pg_dump -U photoalbum photoalbum | gzip > album-db-$(date +%F).sql.gz

# photos (copy the volume contents)
docker run --rm -v photoalbum_photos:/data -v $(pwd):/backup alpine \\
  tar czf /backup/album-photos-$(date +%F).tgz -C /data .
"""),
      P("The volume name is prefixed with the compose project name, normally the folder name; check with "
        "<font face='Courier'>docker volume ls</font>. Restoring is the reverse: create the volumes, extract the archive into the photos "
        "volume, and pipe the dump into psql on the db container."),
      P("Upgrading", H2),
      code("""
git pull
docker compose up --build -d
"""),
      P("Database migrations run automatically at container start. Take a database dump before upgrading, as a precaution.")]

# ---------- 9 ----------
S += [P("9. Development setup and tests", H1),
      P("For working on the code, run the app on your machine with Node 22 and pnpm, and use Docker only for Postgres and a local mail catcher."),
      code("""
pnpm install
cp .env.example .env            # DATABASE_URL should point at localhost:5432
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db mailpit
pnpm prisma migrate dev         # create the schema
pnpm db:seed                    # optional demo data
pnpm dev                        # http://localhost:3000
"""),
      P("Mailpit catches all outgoing mail. Set SMTP_HOST=localhost and SMTP_PORT=1025 in .env and read sign-in emails at "
        "http://localhost:8025. Without SMTP settings the links are printed in the terminal running pnpm dev."),
      P("Scripts", H2),
      table([
        ["Command", "What it does"],
        ["pnpm dev / pnpm build / pnpm start", "Development server / production build / run the build"],
        ["pnpm lint / pnpm typecheck", "ESLint and TypeScript checks"],
        ["pnpm test", "Vitest unit tests (parsers, stats, timeline, auth). Needs a photoalbum_test database: createdb photoalbum_test"],
        ["pnpm build &amp;&amp; pnpm test:e2e", "Playwright smoke tests (sign-in, upload, sharing) against a photoalbum_e2e database"],
        ["pnpm db:migrate / pnpm db:deploy / pnpm db:seed", "Create a migration / apply migrations / load demo data"],
        ["pnpm worker", "Run the background job worker separately (with RUN_WORKER=false on the web process)"],
        ["node scripts/make-fixtures.mjs", "Regenerate test fixture files (GPX, FIT, Google JSON, photos)"],
      ], [2.6*inch, W-2.6*inch]),
      P("Code layout", H2),
      code("""
src/app            routes (Next.js App Router), including /api handlers
src/components     UI components (photos, timeline, map, charts, admin)
src/lib/auth       magic links, sessions, trip access rules
src/lib/images     EXIF, renditions, HEIC conversion
src/lib/tracks     GPX / FIT / Google parsers, stats, simplification, storage encoding
src/lib/jobs       pg-boss queue and the process-photo / import-track / geotag jobs
src/themes         theme registry and per-theme art
prisma             schema, migrations and seed
tests              unit tests, fixtures, Playwright specs
"""),
      P("A GitHub Actions workflow runs lint, typecheck, unit tests and a Docker build on every push.")]

# ---------- 10 ----------
S += [P("10. Troubleshooting", H1),
      table([
        ["Symptom", "Likely cause and fix"],
        ["Sign-in says the address is not recognised", "Only ADMIN_EMAIL, existing members and invited addresses may sign in. Check .env spelling; the app must be restarted after edits."],
        ["No sign-in email arrives", "SMTP_HOST empty (links are in the log: docker compose logs app | grep auth/verify), wrong port/SECURE combination, or the provider rejects SMTP_FROM. Test with Mailpit first."],
        ["Links in emails point to localhost", "APP_URL is still the default. Set it to the public URL and restart."],
        ["Uploads fail around 1 MB or 100 MB", "Reverse proxy body limit (raise client_max_body_size / max_size) or MAX_UPLOAD_BYTES."],
        ["Photo stays on the spinner", "Processing job failed; see the app log. A failed photo shows its error on the detail page. HEIC files take several seconds each."],
        ["Photo landed on the wrong day or trip", "Camera clock or time zone. Open the photo and use the time-zone shift control, or set the trip's time zone correctly before uploading."],
        ["Photo has no location on the map", "No GPS in the file and no track covering that time. Import a GPX/FIT/Google trace for that day; photos are then geotagged from it automatically."],
        ["Google import created nothing", "No points inside the trip's dates. Check the trip dates and that the file is a Timeline export (Timeline.json, Records.json or Semantic Location History)."],
        ["Map is blank", "Tile server unreachable or NEXT_PUBLIC_TILE_URL / NEXT_PUBLIC_MAP_STYLE_URL wrong. Clear them to fall back to OpenStreetMap. NEXT_PUBLIC values are baked in at build time, so rebuild after changing them."],
        ["Container restarts on start", "Migration failure or database not ready; run docker compose logs app. The db service has a health check so app waits for it."],
        ["Disk full", "Photos volume. Move Docker's data root or mount a larger disk at the volume; originals are never deleted automatically."],
      ], [2.0*inch, W-2.0*inch])]

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=0.9*inch, rightMargin=0.9*inch, topMargin=0.8*inch, bottomMargin=0.9*inch,
                        title="Family Album Setup Guide", author="Family Album", subject="Installation, configuration and usage")
doc.build(S, onFirstPage=on_page, onLaterPages=on_page)
print("wrote", OUT)
