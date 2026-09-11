/* Builds tests/fixtures/takeout.zip: a small Google Takeout photo export with every sidecar naming form the importer must handle. */
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import yazl from "yazl";

const fixtures = new URL("../tests/fixtures/", import.meta.url);
// The archive must hold bytes the album has not seen (the importer skips duplicates by content hash), so the fixture
// images are re-encoded with their EXIF kept and the clip gets a trailing `free` box, which every MP4 reader ignores.
const read = (name) => readFileSync(new URL(name, fixtures));
const image = async (name) => sharp(read(name)).withMetadata().jpeg({ quality: 93 }).toBuffer();
const clip = () => Buffer.concat([read("clip.mp4"), Buffer.from([0, 0, 0, 16, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 0, 0, 0, 0, 0])]);
const zip = new yazl.ZipFile();
const add = (p, data) => zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), p);
const side = (o) => JSON.stringify(o, null, 2);
const root = "Takeout/Google Photos/";

// Year bin: a photo with a full-length sidecar carrying a date and a position.
const withGps = await image("photo-with-gps.jpg");
add(`${root}Photos from 2025/photo-with-gps.jpg`, withGps);
add(`${root}Photos from 2025/photo-with-gps.jpg.supplemental-metadata.json`, side({ title: "photo-with-gps.jpg", description: "Otter Cliff from the Ocean Path", photoTakenTime: { timestamp: "1755005400", formatted: "12 Aug 2025" }, geoData: { latitude: 44.3186, longitude: -68.1917, altitude: 12 }, url: "https://photos.google.com/photo/AF1QipMockOtterCliff" }));
// An album folder with a truncated sidecar name.
add(`${root}Lake House/photo-no-gps.jpg`, await image("photo-no-gps.jpg"));
add(`${root}Lake House/photo-no-gps.jpg.supplemental-metadat.json`, side({ title: "photo-no-gps.jpg", description: "Morning at the lake", photoTakenTime: { timestamp: "1562155200" }, geoData: { latitude: 0, longitude: 0 }, geoDataExif: { latitude: 0, longitude: 0 } }));
add(`${root}Lake House/metadata.json`, side({ title: "Lake House", description: "", access: "protected" }));
// A counter-suffixed duplicate name whose sidecar carries the counter after the extension (Google's way): same bytes as the year-bin photo → a duplicate to skip.
add(`${root}Lake House/photo-with-gps(1).jpg`, withGps);
add(`${root}Lake House/photo-with-gps.jpg(1).json`, side({ title: "photo-with-gps(1).jpg", photoTakenTime: { timestamp: "1755005400" } }));
// A third distinct photo with the oldest sidecar form, and a clip.
add(`${root}Photos from 2019/photo-no-exif.jpg`, await image("photo-no-exif.jpg"));
add(`${root}Photos from 2019/photo-no-exif.jpg.json`, side({ title: "photo-no-exif.jpg", photoTakenTime: { timestamp: "1562241600" } }));
add(`${root}Lake House/clip.mp4`, clip());
add(`${root}Lake House/clip.mp4.supple.json`, side({ title: "clip.mp4", photoTakenTime: { timestamp: "1562248800" } }));
// Something the importer must ignore.
add(`${root}Lake House/print-subscriptions.json`, "[]");
add("Takeout/archive_browser.html", "<html></html>");

zip.end();
const out = createWriteStream(fileURLToPath(new URL("takeout.zip", fixtures)));
zip.outputStream.pipe(out).on("close", () => console.log("[make-takeout-fixture] wrote tests/fixtures/takeout.zip"));
