import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILE_SIZE = 50 * 1024; // 50 KB

export interface FileContextOpts {
  files: string[];
  cwd: string;
  maxFileSize?: number;
}

/** Format a single file's content with delimiters */
export function formatFileBlock(relativePath: string, content: string): string {
  return `--- File: ${relativePath} ---\n${content}\n--- End File ---`;
}

/**
 * Read files and build a context prefix to prepend to the prompt.
 * Throws on missing files or files exceeding the size limit.
 */
export async function buildFileContext(opts: FileContextOpts): Promise<string> {
  const { files, cwd, maxFileSize = DEFAULT_MAX_FILE_SIZE } = opts;
  const blocks: string[] = [];

  for (const filePath of files) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, resolved);

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (stat.size > maxFileSize) {
      throw new Error(
        `File exceeds size limit (${stat.size} bytes > ${maxFileSize} bytes): ${filePath}`,
      );
    }

    const content = await fs.readFile(resolved, "utf-8");
    blocks.push(formatFileBlock(relativePath, content));
  }

  return blocks.join("\n\n");
}

/**
 * Prepend file context (and/or spec content) to the original prompt.
 */
export function prependToPrompt(prefix: string, prompt: string): string {
  return `${prefix}\n\n${prompt}`;
}
