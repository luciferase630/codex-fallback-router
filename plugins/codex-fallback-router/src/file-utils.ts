import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await ensureParent(path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, data, { mode });
  try {
    await rename(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await writeFile(path, data, { mode });
  }
  try {
    await chmod(path, mode);
  } catch {
    // Windows enforces access with the user's profile ACL and DPAPI.
  }
}

export async function copyFileWithParents(source: string, destination: string): Promise<void> {
  await ensureParent(destination);
  await copyFile(source, destination);
}

export async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}

