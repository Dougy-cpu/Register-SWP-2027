declare module "unzipper" {
  type DirectoryEntry = {
    pathBuffer: Buffer;
    flags: number;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    offsetToLocalFileHeader: number;
    crc32: number;
  };
  const unzipper: {
    Open: {
      buffer(source: Buffer, options: { tailSize: number }): Promise<{ files: DirectoryEntry[] }>;
    };
  };
  export default unzipper;
}
