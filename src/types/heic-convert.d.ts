declare module "heic-convert" {
  type Options = { buffer: Buffer | Uint8Array; format: "JPEG" | "PNG"; quality?: number };
  function convert(options: Options): Promise<ArrayBuffer>;
  namespace convert {
    function all(options: Options): Promise<{ convert(): Promise<ArrayBuffer> }[]>;
  }
  export default convert;
}
