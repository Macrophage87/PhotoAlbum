import sharp from "sharp";
import exifr from "exifr";
const base = sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg({ quality: 80 });
await base.clone().withExif({
  IFD0: { Make: "Apple", Model: "iPhone 15 Pro", Orientation: "6" },
  IFD2: { DateTimeOriginal: "2025:08:12 15:04:05", OffsetTimeOriginal: "-04:00", ExposureTime: "1/250", FNumber: "1.8", ISOSpeedRatings: "100", FocalLength: "6.9", LensModel: "iPhone 15 Pro back camera" },
  IFD3: { GPSLatitudeRef: "N", GPSLatitude: "44/1 21/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "68/1 12/1 0/1", GPSAltitudeRef: "0", GPSAltitude: "120/1" },
}).toFile("tests/fixtures/photo-with-gps.jpg");
await base.clone().withExif({
  IFD0: { Make: "Canon", Model: "EOS R6" },
  IFD2: { DateTimeOriginal: "2025:08:13 09:30:00" },
}).toFile("tests/fixtures/photo-no-gps.jpg");
await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toFile("tests/fixtures/photo-no-exif.jpg");
for (const f of ["photo-with-gps.jpg", "photo-no-gps.jpg", "photo-no-exif.jpg"]) {
  const raw = await exifr.parse("tests/fixtures/" + f, { reviveValues: false, tiff: true, exif: true, gps: true, ifd0: true, translateKeys: true, translateValues: false, pick: ["DateTimeOriginal","OffsetTimeOriginal","GPSLatitude","GPSLongitude","GPSLatitudeRef","GPSLongitudeRef","GPSAltitude","GPSAltitudeRef","Make","Model","LensModel","ExposureTime","FNumber","ISO","FocalLength","Orientation"] });
  console.log(f, JSON.stringify(raw));
  const g = await exifr.gps("tests/fixtures/" + f);
  console.log("  gps:", g);
}
