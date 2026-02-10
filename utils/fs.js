import fs from "node:fs/promises";

export async function fileExistsAsync(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
