import * as fs from "node:fs/promises";

/**
 * Read the first N lines of a file by reading only `maxBytes` from the start.
 * Avoids allocating the entire file into memory for large JSONL files.
 *
 * @param filePath - Path to the file
 * @param maxLines - Maximum number of lines to return
 * @param maxBytes - Maximum bytes to read from the start (default 8192)
 * @returns Array of complete lines (up to maxLines)
 */
export async function readHead(
  filePath: string,
  maxLines: number,
  maxBytes = 8192,
): Promise<string[]> {
  const fh = await fs.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const bytesToRead = Math.min(maxBytes, stat.size);
    if (bytesToRead === 0) return [];

    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, 0);
    if (bytesRead === 0) return [];

    const text = buf.subarray(0, bytesRead).toString("utf-8");
    const lines = text.split("\n");

    // If we didn't read the whole file, the last chunk may be incomplete — drop it
    if (bytesRead < stat.size) {
      lines.pop();
    }

    return lines.filter((l) => l.length > 0).slice(0, maxLines);
  } finally {
    await fh.close();
  }
}

/**
 * Read the last N lines of a file by reading only `maxBytes` from the end.
 * Avoids allocating the entire file into memory for large JSONL files.
 *
 * @param filePath - Path to the file
 * @param maxLines - Maximum number of lines to return
 * @param maxBytes - Maximum bytes to read from the end (default 65536)
 * @returns Array of complete lines (up to maxLines, in order)
 */
export async function readTail(
  filePath: string,
  maxLines: number,
  maxBytes = 65536,
): Promise<string[]> {
  const fh = await fs.open(filePath, "r");
  try {
    const stat = await fh.stat();
    if (stat.size === 0) return [];

    const bytesToRead = Math.min(maxBytes, stat.size);
    const offset = Math.max(0, stat.size - bytesToRead);

    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, offset);
    if (bytesRead === 0) return [];

    const text = buf.subarray(0, bytesRead).toString("utf-8");
    const lines = text.split("\n");

    // If we didn't start from the beginning, the first chunk may be a partial line — drop it
    if (offset > 0) {
      lines.shift();
    }

    return lines.filter((l) => l.length > 0).slice(-maxLines);
  } finally {
    await fh.close();
  }
}
