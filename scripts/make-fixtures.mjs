/* Generates deterministic test fixtures under tests/fixtures. Run: node scripts/make-fixtures.mjs */
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { FitEncoder, FitBaseType } from "fit-file-parser";

const out = (name, data) => writeFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), data);

// ---------- photos ----------
const base = sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg({ quality: 80 });
await base.clone().withExif({
  IFD0: { Make: "Apple", Model: "iPhone 15 Pro" },
  IFD2: { DateTimeOriginal: "2025:08:12 15:04:05", OffsetTimeOriginal: "-04:00", ExposureTime: "1/250", FNumber: "1.8", ISOSpeedRatings: "100", FocalLength: "6.9", LensModel: "iPhone 15 Pro back camera" },
  IFD3: { GPSLatitudeRef: "N", GPSLatitude: "44/1 21/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "68/1 12/1 0/1", GPSAltitudeRef: "0", GPSAltitude: "120/1" },
}).toFile(new URL("../tests/fixtures/photo-with-gps.jpg", import.meta.url).pathname);
await base.clone().withExif({ IFD0: { Make: "Canon", Model: "EOS R6" }, IFD2: { DateTimeOriginal: "2025:08:12 09:20:00" } }).toFile(new URL("../tests/fixtures/photo-no-gps.jpg", import.meta.url).pathname);
await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toFile(new URL("../tests/fixtures/photo-no-exif.jpg", import.meta.url).pathname);

// A panorama, with Google's GPano tags in an XMP packet — the only thing that tells an album that a 2:1 photo is a
// full sweep of the horizon rather than a wide crop. sharp cannot write XMP, so the APP1 segment goes in by hand,
// straight after the SOI marker where every reader looks for it.
function withXmp(jpeg, xmp) {
  const header = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
  const body = Buffer.concat([header, Buffer.from(xmp, "utf8")]);
  const segment = Buffer.alloc(4 + body.length);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  body.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

const GPANO = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"
  GPano:UsePanoramaViewer="True" GPano:ProjectionType="equirectangular"
  GPano:FullPanoWidthPixels="2400" GPano:FullPanoHeightPixels="1200"
  GPano:CroppedAreaImageWidthPixels="2400" GPano:CroppedAreaImageHeightPixels="1200"
  GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/>
</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;

const sweep = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 90, g: 130, b: 200 } } })
  .composite([{ input: await sharp({ create: { width: 240, height: 1200, channels: 3, background: { r: 230, g: 190, b: 90 } } }).png().toBuffer(), left: 1080, top: 0 }])
  .jpeg({ quality: 80 })
  .toBuffer();
out("panorama.jpg", withXmp(sweep, GPANO));

// A 3D scan, as a phone scanner exports one: a glTF binary holding a single coloured triangle. Small enough to sit
// in the repository, real enough that a viewer draws it and reports its dimensions.
function glb() {
  // One triangle: three positions, float32, and the accessor bounds glTF insists on.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0", generator: "photoalbum fixtures" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "scan" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.4, 0.6, 0.9, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (buf, to) => (buf.length % to === 0 ? buf : Buffer.concat([buf, Buffer.alloc(to - (buf.length % to), 0x20)]));
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), "utf8"), 4);
  const binChunk = pad(bin, 4);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (data, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(jsonChunk, "JSON"), chunk(binChunk, "BIN\0")]);
}
out("scan.glb", glb());

// ---------- a synthetic hike: 1 point / 5 s, ~3 km loop near Acadia with a climb ----------
const T0 = Date.parse("2025-08-12T13:00:00Z");
const N = 600; // 50 minutes
const pts = [];
for (let i = 0; i < N; i++) {
  const f = i / N;
  const lat = 44.35 + 0.012 * Math.sin(2 * Math.PI * f);
  const lng = -68.2 + 0.015 * (Math.cos(2 * Math.PI * f) - 1);
  const ele = 50 + 120 * Math.sin(Math.PI * f) + (i % 7) * 0.4; // up then down, small jitter
  const hr = Math.round(110 + 40 * Math.sin(Math.PI * f));
  const cad = 80 + (i % 5);
  pts.push({ t: T0 + i * 5000, lat, lng, ele, hr, cad });
}

// GPX with Garmin gpxtpx prefix and a <type>
const gpx = (prefix, withType) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="fixture" xmlns="http://www.topografix.com/GPX/1/1" xmlns:${prefix}="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Ocean Path</name></metadata>
  <trk><name>Ocean Path loop</name>${withType ? "<type>hiking</type>" : ""}
    <trkseg>
${pts.map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele><time>${new Date(p.t).toISOString()}</time><extensions><${prefix}:TrackPointExtension><${prefix}:hr>${p.hr}</${prefix}:hr><${prefix}:cad>${p.cad}</${prefix}:cad></${prefix}:TrackPointExtension></extensions></trkpt>`).join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
out("sample-hr.gpx", gpx("gpxtpx", true));
out("sample-ns3.gpx", gpx("ns3", false));
out("sample.gpx", `<?xml version="1.0"?><gpx version="1.1" creator="fixture" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Plain</name><trkseg>${pts
  .slice(0, 100)
  .map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
  .join("")}</trkseg></trk></gpx>`);

// FIT: file_id + records + session
const semi = (d) => Math.round(d * (2 ** 31 / 180));
const enc = new FitEncoder();
enc.writeMessage(0, [
  { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
  { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },
  { number: 2, size: 2, baseType: FitBaseType.Uint16, value: 1 },
  { number: 3, size: 4, baseType: FitBaseType.Uint32z, value: 12345 },
  { number: 4, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(T0)) },
]);
let dist = 0;
for (let i = 0; i < pts.length; i++) {
  const p = pts[i];
  if (i > 0) {
    const q = pts[i - 1];
    const dLat = (p.lat - q.lat) * 110540, dLng = (p.lng - q.lng) * 111320 * Math.cos((p.lat * Math.PI) / 180);
    dist += Math.hypot(dLat, dLng);
  }
  enc.writeMessage(20, [
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(p.t)) },
    { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semi(p.lat) },
    { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semi(p.lng) },
    { number: 2, size: 2, baseType: FitBaseType.Uint16, value: Math.round((p.ele + 500) * 5) },
    { number: 3, size: 1, baseType: FitBaseType.Uint8, value: p.hr },
    { number: 4, size: 1, baseType: FitBaseType.Uint8, value: p.cad },
    { number: 5, size: 4, baseType: FitBaseType.Uint32, value: Math.round(dist * 100) },
    { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 1200 },
    { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 150 + (i % 20) },
  ], 1);
}
enc.writeMessage(18, [
  { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(pts[pts.length - 1].t)) },
  { number: 2, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(T0)) },
  { number: 5, size: 1, baseType: FitBaseType.Enum, value: 17 }, // hiking
  { number: 7, size: 4, baseType: FitBaseType.Uint32, value: (N - 1) * 5 * 1000 },
  { number: 8, size: 4, baseType: FitBaseType.Uint32, value: (N - 1) * 5 * 1000 - 120000 },
  { number: 9, size: 4, baseType: FitBaseType.Uint32, value: Math.round(dist * 100) },
  { number: 11, size: 2, baseType: FitBaseType.Uint16, value: 420 },
  { number: 16, size: 1, baseType: FitBaseType.Uint8, value: 135 },
  { number: 17, size: 1, baseType: FitBaseType.Uint8, value: 150 },
  { number: 22, size: 2, baseType: FitBaseType.Uint16, value: 125 },
  { number: 23, size: 2, baseType: FitBaseType.Uint16, value: 125 },
], 2);
out("sample.fit", Buffer.from(enc.close()));

// ---------- Google exports (a mix of in-window and out-of-window points) ----------
const iso = (ms) => new Date(ms).toISOString();
const IN = Date.parse("2025-08-12T14:00:00Z"), OUT = Date.parse("2025-06-01T12:00:00Z");
out("google-records.json", JSON.stringify({
  locations: [
    { latitudeE7: 443500000, longitudeE7: -682000000, accuracy: 10, timestamp: iso(IN) },
    { latitudeE7: 443510000, longitudeE7: -682010000, accuracy: 15, timestampMs: String(IN + 60000), altitude: 40 },
    { latitudeE7: 443520000, longitudeE7: -682020000, accuracy: 900, timestamp: iso(IN + 120000) },
    { latitudeE7: 443530000, longitudeE7: -682030000, accuracy: 12, timestamp: iso(IN + 180000) },
    { latitudeE7: 443540000, longitudeE7: -682040000, accuracy: 12, timestamp: iso(IN + 86400000 * 2) },
    { latitudeE7: 407000000, longitudeE7: -740000000, accuracy: 10, timestamp: iso(OUT) },
  ],
}, null, 1));
const segments = [
  { startTime: iso(IN), endTime: iso(IN + 600000), timelinePath: [{ point: "geo:44.3500,-68.2000", time: iso(IN) }, { point: "geo:44.3510,-68.2010", durationMinutesOffsetFromStartTime: "5" }, { point: "geo:44.3520,-68.2020", time: iso(IN + 600000) }] },
  { startTime: iso(IN + 700000), endTime: iso(IN + 4000000), visit: { topCandidate: { placeLocation: { latLng: "44.3530°, -68.2030°" } } } },
  { startTime: iso(IN + 5000000), endTime: iso(IN + 6000000), activity: { start: { latLng: "44.3530°, -68.2030°" }, end: { latLng: "44.3600°, -68.2100°" } } },
  { startTime: iso(OUT), endTime: iso(OUT + 600000), timelinePath: [{ point: "geo:40.7,-74.0", time: iso(OUT) }] },
];
out("google-timeline-android.json", JSON.stringify({ semanticSegments: segments, rawSignals: [] }, null, 1));
out("google-timeline-ios.json", JSON.stringify(segments, null, 1));
out("google-semantic.json", JSON.stringify({
  timelineObjects: [
    { activitySegment: { startLocation: { latitudeE7: 443500000, longitudeE7: -682000000 }, endLocation: { latitudeE7: 443520000, longitudeE7: -682020000 }, duration: { startTimestamp: iso(IN), endTimestamp: iso(IN + 600000) }, waypointPath: { waypoints: [{ latE7: 443510000, lngE7: -682010000 }] } } },
    { placeVisit: { location: { latitudeE7: 443530000, longitudeE7: -682030000 }, duration: { startTimestamp: iso(IN + 700000), endTimestamp: iso(IN + 4000000) } } },
    { activitySegment: { duration: { startTimestamp: iso(IN + 5000000), endTimestamp: iso(IN + 6000000) }, simplifiedRawPath: { points: [{ latE7: 443530000, lngE7: -682030000, timestampMs: String(IN + 5000000) }, { latE7: 443600000, lngE7: -682100000, timestamp: iso(IN + 6000000) }] } } },
    { activitySegment: { startLocation: { latitudeE7: 407000000, longitudeE7: -740000000 }, endLocation: { latitudeE7: 407100000, longitudeE7: -740100000 }, duration: { startTimestamp: iso(OUT), endTimestamp: iso(OUT + 60000) } } },
  ],
}, null, 1));
console.log("fixtures written");
