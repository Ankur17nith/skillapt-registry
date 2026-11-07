import { LIMITS, ALLOWED_FILE_EXTENSIONS, ALLOWED_SPECIAL_FILES } from "../config";
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
 * Parses null-terminated ASCII/UTF-8 string from header block.
 */
function parseString(buffer: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && buffer[end] !== 0) {
    end++;
  }
  return new TextDecoder("utf-8").decode(buffer.subarray(offset, end)).trim();
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

  let offset = 0;
  let fileCount = 0;
  const entries: TarEntry[] = [];
  let skillJsonData: Uint8Array | null = null;
  let skillMdContent: string | null = null;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);

    // End of archive is marked by two consecutive blocks of zero bytes
    const isZeroBlock = header.every((b) => b === 0);
    if (isZeroBlock) {
      break;
    }

    // Read file name (support ustar prefix)
    const namePart = parseString(header, 0, 100);
    const prefixPart = parseString(header, 345, 155);
    const fullPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;

    if (!fullPath) {
      offset += 512;
      continue;
    }

    // Path security: check path length
    if (fullPath.length > LIMITS.MAX_PATH_LENGTH) {
      return {
        success: false,
        error: `File path '${fullPath}' exceeds maximum length of ${LIMITS.MAX_PATH_LENGTH} characters.`
      };
    }

    // Path security: Traversal and Absolute Path checks
    if (fullPath.includes("\0")) {
      return { success: false, error: "File path contains invalid null bytes." };
    }
    if (fullPath.startsWith("/") || fullPath.startsWith("\\") || /^[a-zA-Z]:/.test(fullPath)) {
      return { success: false, error: `Absolute paths are strictly forbidden: '${fullPath}'` };
    }
    const pathSegments = fullPath.split(/[/\\]/);
    if (pathSegments.includes("..")) {
      return {
        success: false,
        error: `Path traversal detected in archive entry: '${fullPath}'`
      };
    }

    // Read type flag and size
    const typeFlag = String.fromCharCode(header[156]) || "0";
    const size = parseOctal(header, 124, 12);

    // Security: Reject symlinks, hardlinks, character/block devices, and FIFOs
    if (typeFlag === "1" || typeFlag === "2") {
      return {
        success: false,
        error: `Symlinks and hardlinks are strictly prohibited in packages: '${fullPath}'`
      };
    }
    if (typeFlag === "3" || typeFlag === "4" || typeFlag === "6") {
      return {
        success: false,
        error: `Special device/FIFO files are strictly prohibited: '${fullPath}'`
      };
    }

    offset += 512;

    // Is this a directory?
    const isDirectory = typeFlag === "5" || fullPath.endsWith("/");
    if (isDirectory) {
      continue;
    }

    // Regular file validation
    fileCount++;
    if (fileCount > LIMITS.MAX_FILE_COUNT) {
      return {
        success: false,
        error: `Archive exceeds maximum file count limit of ${LIMITS.MAX_FILE_COUNT} files.`
      };
    }

    // Extract file payload
    const fileData = tarBytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    // Check file extension safety
    const basename = pathSegments[pathSegments.length - 1];
    const isSpecialAllowed = ALLOWED_SPECIAL_FILES.has(basename);

    if (basename.startsWith(".") && !isSpecialAllowed) {
      return {
        success: false,
        error: `Hidden file '${basename}' is not permitted in package.`
      };
    }

    const dotIndex = basename.lastIndexOf(".");
    const ext = dotIndex !== -1 ? basename.slice(dotIndex).toLowerCase() : "";

    if (!isSpecialAllowed && (!ext || !ALLOWED_FILE_EXTENSIONS.has(ext))) {
      return {
        success: false,
        error: `File type '${ext || basename}' is not permitted in skill packages.`
      };
    }

    // Normalize path by ignoring single root directory wrapper (e.g. "my-skill/skill.json" -> "skill.json")
    const normalizedParts = pathSegments.filter((p) => p !== "." && p !== "");
    const isSkillJson =
      normalizedParts.length === 1 && normalizedParts[0] === "skill.json" ||
      normalizedParts.length === 2 && normalizedParts[1] === "skill.json";

    const isSkillMd =
      normalizedParts.length === 1 && normalizedParts[0] === "SKILL.md" ||
      normalizedParts.length === 2 && normalizedParts[1] === "SKILL.md";

    if (isSkillJson) {
      skillJsonData = fileData;
    } else if (isSkillMd) {
      skillMdContent = new TextDecoder("utf-8").decode(fileData).trim();
    }

    entries.push({
      path: fullPath,
      size,
      typeFlag,
      data: fileData
    });
  }

  // 3. Verify required files
  if (!skillJsonData) {
    return {
      success: false,
      error: "Package archive is missing required 'skill.json' manifest file."
    };
  }

  if (!skillMdContent) {
    return {
      success: false,
      error: "Package archive is missing required 'SKILL.md' documentation file or it is empty."
    };
  }

  // 4. Validate skill.json content against Zod schema
  let parsedJson: unknown;
  try {
    const jsonString = new TextDecoder("utf-8").decode(skillJsonData);
    parsedJson = JSON.parse(jsonString);
  } catch (err) {
    return {
      success: false,
      error: "Failed to parse 'skill.json' manifest: invalid JSON syntax."
    };
  }

  const manifestValidation = validateManifest(parsedJson);
  if (!manifestValidation.success) {
    return {
      success: false,
      error: `Manifest validation failed: ${manifestValidation.errors.join("; ")}`
    };
  }

  return {
    success: true,
    manifest: manifestValidation.data,
    readme: skillMdContent,
    fileCount,
    uncompressedSize: tarBytes.byteLength
  };
}
