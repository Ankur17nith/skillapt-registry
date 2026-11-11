import zlib from "node:zlib";

export interface TarFileEntry {
  path: string;
  content: string | Uint8Array;
  typeFlag?: string; // '0' = file, '2' = symlink, '5' = dir, 'x' = pax
  linkName?: string;
  corruptChecksum?: boolean;
}

export function createTarBlock(entry: TarFileEntry): Uint8Array {
  const block = new Uint8Array(512);
  const encoder = new TextEncoder();

  // Path (0..99)
  const pathBytes = encoder.encode(entry.path);
  block.set(pathBytes.subarray(0, 100), 0);

  // File mode (100..107): 0000644
  block.set(encoder.encode("0000644\0"), 100);

  // UID (108..115): 0000000
  block.set(encoder.encode("0000000\0"), 108);

  // GID (116..123): 0000000
  block.set(encoder.encode("0000000\0"), 116);

  // Size in octal (124..135)
  const contentBytes =
    typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
  const sizeOctal = contentBytes.length.toString(8).padStart(11, "0") + " ";
  block.set(encoder.encode(sizeOctal), 124);

  // Mtime (136..147)
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + " ";
  block.set(encoder.encode(mtimeOctal), 136);

  // Type flag (156)
  block[156] = entry.typeFlag ? entry.typeFlag.charCodeAt(0) : "0".charCodeAt(0);

  // Link name (157..256)
  if (entry.linkName) {
    block.set(encoder.encode(entry.linkName).subarray(0, 100), 157);
  }

  // Magic & version: ustar\x0000
  block.set(encoder.encode("ustar\x0000"), 257);

  // Pre-calculate checksum: fill checksum field (148..155) with 8 spaces
  for (let i = 148; i < 156; i++) {
    block[i] = " ".charCodeAt(0);
  }

  let chksum = 0;
  for (let i = 0; i < 512; i++) {
    chksum += block[i];
  }

  if (entry.corruptChecksum) {
    chksum ^= 0xff;
  }

  const chksumOctal = chksum.toString(8).padStart(6, "0") + "\0 ";
  block.set(encoder.encode(chksumOctal), 148);

  return block;
}

export function createPaxEntry(records: Record<string, string>): TarFileEntry {
  let content = "";
  for (const [k, v] of Object.entries(records)) {
    const base = ` ${k}=${v}\n`;
    let len = base.length + 2;
    while (`${len}${base}`.length !== len) {
      len = `${len}${base}`.length;
    }
    content += `${len}${base}`;
  }
  return {
    path: "PaxHeaders/pax",
    content,
    typeFlag: "x"
  };
}

export function buildTarGz(entries: TarFileEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const header = createTarBlock(entry);
    chunks.push(header);

    const contentBytes =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;

    if (contentBytes.length > 0) {
      chunks.push(contentBytes);
      const remainder = contentBytes.length % 512;
      if (remainder !== 0) {
        chunks.push(new Uint8Array(512 - remainder));
      }
    }
  }

  // Two 512-byte zero blocks at end of archive
  chunks.push(new Uint8Array(1024));

  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const tarBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    tarBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return zlib.gzipSync(tarBytes);
}
