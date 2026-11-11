import yaml from "yaml";
import {
  LIMITS,
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_SPECIAL_FILES,
  ALLOWED_EXTENSIONLESS_FILES
} from "../config";
import { validateManifest, type ValidatedSkillManifest } from "./manifest";

export interface PackageValidationResult {
  success: boolean;
  manifest?: ValidatedSkillManifest;
  readme?: string;
  fileCount?: number;
  uncompressedSize?: number;
  error?: string;
}

interface TarEntry {
  path: string;
  size: number;
  typeFlag: string;
  data: Uint8Array;
}

/**
 * Decompresses a gzipped Uint8Array using web standard DecompressionStream.
 */
async function decompressGzip(gzippedData: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(gzippedData);
      controller.close();
    }
  });

  const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Decompressed archive size exceeds safety limit of ${Math.round(maxBytes / (1024 * 1024))} MB.`
        );
      }
      chunks.push(value);
    }
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Parses an octal string from a tar header block.
 */
function parseOctal(buffer: Uint8Array, offset: number, length: number): number {
  let str = "";
  for (let i = offset; i < offset + length; i++) {
    const char = String.fromCharCode(buffer[i]);
    if (char === "\0" || char === " ") break;
    str += char;
  }
  return str ? parseInt(str, 8) || 0 : 0;
}

/**
 * Parses null-terminated ASCII string from header block without trimming.
 */
function parseRawHeaderString(buffer: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && buffer[end] !== 0) {
    end++;
  }
  return new TextDecoder("utf-8").decode(buffer.subarray(offset, end));
}

/**
 * Verifies standard ustar/POSIX tar header checksum.
 */
function verifyHeaderChecksum(header: Uint8Array): boolean {
  const recordedChecksum = parseOctal(header, 148, 8);
  let unsignedSum = 0;
  let signedSum = 0;

  for (let i = 0; i < 512; i++) {
    const byteVal = i >= 148 && i < 156 ? 0x20 : header[i];
    unsignedSum += byteVal;
    signedSum += byteVal > 127 ? byteVal - 256 : byteVal;
  }

  return recordedChecksum === unsignedSum || recordedChecksum === signedSum;
}

/**
 * Parses PAX extended header records.
 */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const text = new TextDecoder("utf-8").decode(data);
  const records = new Map<string, string>();
  let pos = 0;

  while (pos < text.length) {
    const spaceIdx = text.indexOf(" ", pos);
    if (spaceIdx === -1) break;
    const lenStr = text.slice(pos, spaceIdx);
    const length = parseInt(lenStr, 10);
    if (isNaN(length) || length <= 0) break;

    const recordEnd = pos + length;
    const line = text.slice(spaceIdx + 1, recordEnd - 1); // exclude trailing newline
    const eqIdx = line.indexOf("=");
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx);
      const val = line.slice(eqIdx + 1);
      records.set(key, val);
    }
    pos = recordEnd;
  }

  return records;
}

/**
 * Checks magic bytes in the first 512 bytes of a file.
 */
function detectForbiddenMagicBytes(data: Uint8Array): string | null {
  if (data.length < 2) return null;

  // PE "MZ" executable
  if (data[0] === 0x4d && data[1] === 0x5a) {
    return "PE executable (MZ)";
  }

  if (data.length >= 4) {
    // ELF executable
    if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
      return "ELF binary";
    }

    // WASM binary
    if (data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d) {
      return "WebAssembly binary";
    }

    // Java class file / Mach-O Fat Binary
    if (data[0] === 0xca && data[1] === 0xfe && data[2] === 0xba && data[3] === 0xbe) {
      return "Java class / Mach-O universal binary";
    }
    if (data[0] === 0xbe && data[1] === 0xba && data[2] === 0xfe && data[3] === 0xca) {
      return "Mach-O universal binary";
    }

    // Mach-O 32-bit and 64-bit binaries
    if (
      (data[0] === 0xfe && data[1] === 0xed && data[2] === 0xfa && (data[3] === 0xce || data[3] === 0xcf)) ||
      (data[3] === 0xfe && data[2] === 0xed && data[1] === 0xfa && (data[0] === 0xce || data[0] === 0xcf))
    ) {
      return "Mach-O binary";
    }
  }

  return null;
}

/**
 * Extracts and strictly validates a tar archive.
 */
export async function inspectAndValidateTarball(
  tarGzBytes: Uint8Array
): Promise<PackageValidationResult> {
  // 1. Verify compressed size limit
  if (tarGzBytes.byteLength > LIMITS.MAX_TARBALL_SIZE_BYTES) {
    return {
      success: false,
      error: `Package archive size (${(tarGzBytes.byteLength / (1024 * 1024)).toFixed(
        2
      )} MB) exceeds the 5 MB upload limit.`
    };
  }

  // 2. Decompress archive with zip-bomb protection
  let tarBytes: Uint8Array;
  try {
    tarBytes = await decompressGzip(tarGzBytes, LIMITS.MAX_UNCOMPRESSED_SIZE_BYTES);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to decompress gzip archive."
    };
  }

  if (tarBytes.byteLength > LIMITS.MAX_UNCOMPRESSED_SIZE_BYTES) {
    return {
      success: false,
      error: `Decompressed archive size exceeds limit of 25 MB.`
    };
  }

  let offset = 0;
  let fileCount = 0;
  let totalDeclaredSize = 0;
  const entries: TarEntry[] = [];
  const seenPaths = new Set<string>();

  let pendingPaxPath: string | null = null;
  let pendingPaxSize: number | null = null;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);

    // End of archive is marked by two consecutive blocks of zero bytes
    const isZeroBlock = header.every((b) => b === 0);
    if (isZeroBlock) {
      break;
    }

    // Verify header checksum
    if (!verifyHeaderChecksum(header)) {
      return {
        success: false,
        error: "Tar header checksum verification failed: corrupted archive."
      };
    }

    const typeFlag = String.fromCharCode(header[156]) || "0";
    let rawSize = parseOctal(header, 124, 12);

    // Read header name and prefix without trimming
    const namePart = parseRawHeaderString(header, 0, 100);
    const prefixPart = parseRawHeaderString(header, 345, 155);
    let headerPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;

    offset += 512;

    // Handle PAX extended headers ('x')
    if (typeFlag === "x") {
      const paxData = tarBytes.subarray(offset, offset + rawSize);
      offset += Math.ceil(rawSize / 512) * 512;
      const paxRecords = parsePaxRecords(paxData);
      if (paxRecords.has("path")) {
        pendingPaxPath = paxRecords.get("path")!;
      }
      if (paxRecords.has("size")) {
        pendingPaxSize = parseInt(paxRecords.get("size")!, 10);
      }
      continue;
    }

    // Reject PAX global ('g') headers
    if (typeFlag === "g") {
      return {
        success: false,
        error: "PAX global extended headers ('g') are not permitted."
      };
    }

    // Reject GNU long name/link headers ('L', 'K')
    if (typeFlag === "L" || typeFlag === "K") {
      return {
        success: false,
        error: "GNU long path/link headers are not permitted. Standard PAX headers must be used."
      };
    }

    // Reject symlinks, hardlinks, character/block devices, FIFOs
    if (typeFlag === "1" || typeFlag === "2") {
      return {
        success: false,
        error: `Symlinks and hardlinks are strictly prohibited in packages: '${headerPath}'`
      };
    }
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "5") {
      return {
        success: false,
        error: `Unsupported tar entry type flag '${typeFlag}': '${headerPath}'`
      };
    }

    // Determine EFFECTIVE path and size
    const effectivePath = pendingPaxPath !== null ? pendingPaxPath : headerPath;
    const effectiveSize = pendingPaxSize !== null ? pendingPaxSize : rawSize;

    // Reset pending PAX values
    pendingPaxPath = null;
    pendingPaxSize = null;

    if (!effectivePath) {
      offset += Math.ceil(rawSize / 512) * 512;
      continue;
    }

    // Path security: strict validation on effective path
    if (effectivePath.length > LIMITS.MAX_PATH_LENGTH) {
      return {
        success: false,
        error: `File path '${effectivePath}' exceeds maximum length of ${LIMITS.MAX_PATH_LENGTH} characters.`
      };
    }

    // Reject control characters
    if (/[\x00-\x1F\x7F]/.test(effectivePath)) {
      return {
        success: false,
        error: `File path '${effectivePath}' contains invalid control characters.`
      };
    }

    // Reject backslashes
    if (effectivePath.includes("\\")) {
      return {
        success: false,
        error: `File path '${effectivePath}' contains backslashes. Use forward slashes only.`
      };
    }

    // Check for leading or trailing spaces on the overall path
    if (effectivePath.startsWith(" ") || effectivePath.endsWith(" ")) {
      return {
        success: false,
        error: `File path '${effectivePath}' contains leading or trailing spaces.`
      };
    }

    // Reject absolute paths
    if (effectivePath.startsWith("/") || /^[a-zA-Z]:/.test(effectivePath)) {
      return {
        success: false,
        error: `Absolute paths are strictly forbidden: '${effectivePath}'`
      };
    }

    // Check path segments
    const isDirEntry = typeFlag === "5" || effectivePath.endsWith("/");
    const cleanPath = isDirEntry && effectivePath.endsWith("/")
      ? effectivePath.slice(0, -1)
      : effectivePath;

    const segments = cleanPath.split("/");

    // Reject empty segments (e.g. double slash "//")
    if (segments.some((s) => s.length === 0)) {
      return {
        success: false,
        error: `File path '${effectivePath}' contains empty segments.`
      };
    }

    // Reject leading/trailing spaces in individual segments
    if (segments.some((s) => s.trim() !== s)) {
      return {
        success: false,
        error: `File path segment contains leading or trailing spaces in '${effectivePath}'.`
      };
    }

    // Reject path traversal
    if (segments.includes("..") || segments.includes(".")) {
      return {
        success: false,
        error: `Path traversal detected in archive entry: '${effectivePath}'`
      };
    }

    // Reject hidden rule on EVERY path segment (files and directories)
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startsWith(".")) {
        const isLeaf = i === segments.length - 1 && !isDirEntry;
        if (!isLeaf || !ALLOWED_SPECIAL_FILES.has(seg)) {
          return {
            success: false,
            error: isLeaf
              ? `Hidden file '${seg}' is not permitted in package: '${effectivePath}'`
              : `Hidden path segment '${seg}' is not permitted: '${effectivePath}'`
          };
        }
      }
    }

    // Reject duplicate paths (NFC normalized and case-insensitive)
    const normalizedKey = effectivePath.normalize("NFC").toLowerCase();
    if (seenPaths.has(normalizedKey)) {
      return {
        success: false,
        error: `Duplicate path detected in archive: '${effectivePath}'`
      };
    }
    seenPaths.add(normalizedKey);

    // Sum of declared entry sizes
    totalDeclaredSize += effectiveSize;
    if (totalDeclaredSize > LIMITS.MAX_UNCOMPRESSED_SIZE_BYTES) {
      return {
        success: false,
        error: `Total declared uncompressed size exceeds limit of 25 MB.`
      };
    }

    if (isDirEntry) {
      offset += Math.ceil(rawSize / 512) * 512;
      continue;
    }

    // Regular file checks
    fileCount++;
    if (fileCount > LIMITS.MAX_FILE_COUNT) {
      return {
        success: false,
        error: `Archive exceeds maximum file count limit of ${LIMITS.MAX_FILE_COUNT} files.`
      };
    }

    // Extract payload
    const fileData = tarBytes.subarray(offset, offset + effectiveSize);
    offset += Math.ceil(rawSize / 512) * 512;

    // Check allowlist first
    const leafName = segments[segments.length - 1];
    const isSpecialAllowed = ALLOWED_SPECIAL_FILES.has(leafName);
    const isExtensionlessAllowed = ALLOWED_EXTENSIONLESS_FILES.has(leafName.toLowerCase());

    const dotIndex = leafName.lastIndexOf(".");
    const ext = dotIndex !== -1 ? leafName.slice(dotIndex).toLowerCase() : "";

    if (!isSpecialAllowed && !isExtensionlessAllowed) {
      if (!ext || !ALLOWED_FILE_EXTENSIONS.has(ext)) {
        return {
          success: false,
          error: `File type '${ext || leafName}' is not permitted in skill packages: '${effectivePath}'`
        };
      }
    }

    // Check magic bytes for forbidden binary signatures (even with an allowed extension)
    const forbiddenMagic = detectForbiddenMagicBytes(fileData);
    if (forbiddenMagic) {
      return {
        success: false,
        error: `Executable or binary file detected (${forbiddenMagic}): '${effectivePath}'`
      };
    }

    entries.push({
      path: effectivePath,
      size: effectiveSize,
      typeFlag,
      data: fileData
    });
  }

  // Check if any regular files were found
  if (entries.length === 0) {
    return {
      success: false,
      error: "Archive contains no files."
    };
  }

  // 3. Layout validation: files at root or under exactly one wrapper directory
  // Find common wrapper directory if any
  const firstSegments = new Set(entries.map((e) => e.path.split("/")[0]));
  let wrapperDir: string | null = null;

  if (firstSegments.size === 1) {
    const candidateWrapper = Array.from(firstSegments)[0];
    const allHaveWrapper = entries.every((e) => {
      const parts = e.path.split("/");
      return parts.length > 1 && parts[0] === candidateWrapper;
    });
    if (allHaveWrapper) {
      wrapperDir = candidateWrapper;
    }
  }

  // If some files are at root and some are in multiple roots without a single wrapper,
  // check if any root files exist alongside subdirectories with different roots
  if (!wrapperDir && firstSegments.size > 1) {
    // If multiple root segments exist, files MUST be at root level or standard subdirectories,
    // but cannot be split across multiple top-level wrapper directories if no files at root
    const hasFilesAtRoot = entries.some((e) => !e.path.includes("/"));
    if (!hasFilesAtRoot) {
      return {
        success: false,
        error: "Package archive layout invalid: files are divided under multiple top-level directories."
      };
    }
  }

  // Strip wrapper if present to determine package-root paths
  let skillJsonData: Uint8Array | null = null;
  let skillMdData: Uint8Array | null = null;
  let skillJsonCount = 0;
  let skillMdCount = 0;

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const strippedParts = wrapperDir ? parts.slice(1) : parts;
    const strippedPath = strippedParts.join("/");

    if (strippedPath === "skill.json") {
      skillJsonCount++;
      skillJsonData = entry.data;
    } else if (strippedParts[strippedParts.length - 1] === "skill.json") {
      return {
        success: false,
        error: `Manifest confusion: 'skill.json' must only exist at package root, found at '${entry.path}'.`
      };
    }

    if (strippedPath === "SKILL.md") {
      skillMdCount++;
      skillMdData = entry.data;
    } else if (strippedParts[strippedParts.length - 1] === "SKILL.md") {
      return {
        success: false,
        error: `Manifest confusion: 'SKILL.md' must only exist at package root, found at '${entry.path}'.`
      };
    }
  }

  if (skillJsonCount !== 1 || !skillJsonData) {
    return {
      success: false,
      error: "Package archive is missing required 'skill.json' manifest file at package root."
    };
  }

  if (
    skillMdCount !== 1 ||
    !skillMdData ||
    new TextDecoder("utf-8").decode(skillMdData).trim().length === 0
  ) {
    return {
      success: false,
      error: "Package archive is missing required 'SKILL.md' documentation file or it is empty."
    };
  }

  // 4. Validate SKILL.md size and YAML frontmatter
  if (skillMdData.byteLength > LIMITS.MAX_SKILL_MD_SIZE_BYTES) {
    return {
      success: false,
      error: `SKILL.md size (${skillMdData.byteLength} bytes) exceeds maximum limit of 256 KB.`
    };
  }

  const skillMdContent = new TextDecoder("utf-8").decode(skillMdData);
  const frontmatterMatch = skillMdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (!frontmatterMatch) {
    return {
      success: false,
      error: "SKILL.md must begin with YAML frontmatter delimited by '---'."
    };
  }

  let parsedFrontmatter: Record<string, unknown>;
  try {
    parsedFrontmatter = yaml.parse(frontmatterMatch[1]);
    if (!parsedFrontmatter || typeof parsedFrontmatter !== "object") {
      return {
        success: false,
        error: "SKILL.md frontmatter must be a valid YAML object."
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `SKILL.md frontmatter YAML parsing error: ${err instanceof Error ? err.message : "invalid YAML"}`
    };
  }

  // 5. Parse and validate skill.json
  let parsedManifestJson: unknown;
  try {
    const jsonString = new TextDecoder("utf-8").decode(skillJsonData);
    parsedManifestJson = JSON.parse(jsonString);
  } catch {
    return {
      success: false,
      error: "Failed to parse 'skill.json' manifest: invalid JSON syntax."
    };
  }

  const manifestValidation = validateManifest(parsedManifestJson);
  if (!manifestValidation.success) {
    return {
      success: false,
      error: `Manifest validation failed: ${manifestValidation.errors.join("; ")}`
    };
  }

  const manifest = manifestValidation.data;

  // Validate SKILL.md frontmatter fields against manifest
  const unscopedName = manifest.name.includes("/") ? manifest.name.split("/")[1] : manifest.name;

  if (parsedFrontmatter.name !== unscopedName) {
    return {
      success: false,
      error: `SKILL.md frontmatter name '${parsedFrontmatter.name}' must match unscoped package name '${unscopedName}'.`
    };
  }

  if (
    typeof parsedFrontmatter.description !== "string" ||
    parsedFrontmatter.description.trim().length === 0
  ) {
    return {
      success: false,
      error: "SKILL.md frontmatter description must be a non-empty string."
    };
  }

  return {
    success: true,
    manifest,
    readme: skillMdContent,
    fileCount,
    uncompressedSize: tarBytes.byteLength
  };
}
