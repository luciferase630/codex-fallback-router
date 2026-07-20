import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { atomicWriteFile, pathExists } from "./file-utils.js";

export interface RootConfigValues {
  chatgptBaseUrl?: string;
  disableResponseStorage?: boolean;
}

export interface CodexConfigEditResult {
  original: RootConfigValues;
  editedText: string;
}

export interface ModelProviderConfigValues {
  baseUrl?: string;
  wireApi?: string;
  requiresOpenAiAuth?: boolean;
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function decodeTomlString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return undefined;
}

function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

export function inspectRootConfig(text: string): RootConfigValues {
  const values: RootConfigValues = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const baseMatch = line.match(/^\s*chatgpt_base_url\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (baseMatch?.[1]) {
      const value = decodeTomlString(baseMatch[1]);
      if (value !== undefined) values.chatgptBaseUrl = value;
    }
    const storageMatch = line.match(/^\s*disable_response_storage\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (storageMatch?.[1]) values.disableResponseStorage = storageMatch[1].toLowerCase() === "true";
  }
  return values;
}

export function inspectRootModel(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!match?.[1]) continue;
    const value = decodeTomlString(match[1]);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function inspectRootModelProvider(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model_provider\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!match?.[1]) continue;
    const value = decodeTomlString(match[1]);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function sectionName(line: string): string | undefined {
  const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
  return match?.[1]?.trim();
}

function isProviderSection(name: string | undefined, providerId: string): boolean {
  return name === `model_providers.${providerId}` || name === `model_providers.${JSON.stringify(providerId)}`;
}

function providerSectionBounds(lines: string[], providerId: string): { start: number; end: number } {
  const start = lines.findIndex((line) => isProviderSection(sectionName(line), providerId));
  if (start < 0) throw new Error(`Active model provider section was not found: ${providerId}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (sectionName(lines[index] ?? "") !== undefined) {
      end = index;
      break;
    }
  }
  return { start, end };
}

export function inspectModelProviderConfig(text: string, providerId: string): ModelProviderConfigValues {
  const lines = text.split(/\r?\n/);
  const { start, end } = providerSectionBounds(lines, providerId);
  const values: ModelProviderConfigValues = {};
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const baseMatch = line.match(/^\s*base_url\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (baseMatch?.[1]) {
      const value = decodeTomlString(baseMatch[1]);
      if (value !== undefined) values.baseUrl = value;
    }
    const wireMatch = line.match(/^\s*wire_api\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (wireMatch?.[1]) {
      const value = decodeTomlString(wireMatch[1]);
      if (value !== undefined) values.wireApi = value;
    }
    const authMatch = line.match(/^\s*requires_openai_auth\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (authMatch?.[1]) values.requiresOpenAiAuth = authMatch[1].toLowerCase() === "true";
  }
  return values;
}

function setModelProviderBaseUrl(text: string, providerId: string, value: string | undefined): string {
  const newline = newlineOf(text);
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  const { start, end } = providerSectionBounds(lines, providerId);
  const output: string[] = [];
  let handled = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index > start && index < end && /^\s*base_url\s*=/.test(line)) {
      if (!handled && value !== undefined) output.push(`base_url = ${encodeTomlString(value)}`);
      handled = true;
      continue;
    }
    output.push(line);
  }
  if (!handled && value !== undefined) {
    let insertAt = end;
    while (insertAt > start + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt -= 1;
    const removedBeforeInsert = lines.slice(start + 1, insertAt).filter((line) => /^\s*base_url\s*=/.test(line)).length;
    output.splice(insertAt - removedBeforeInsert, 0, `base_url = ${encodeTomlString(value)}`);
  }
  let result = output.join(newline);
  if (hadTrailingNewline && !result.endsWith(newline)) result += newline;
  return result;
}

export function editModelProviderBaseUrl(
  text: string,
  providerId: string,
  desiredBaseUrl: string,
): { originalBaseUrl?: string; editedText: string } {
  const originalBaseUrl = inspectModelProviderConfig(text, providerId).baseUrl;
  return {
    ...(originalBaseUrl !== undefined ? { originalBaseUrl } : {}),
    editedText: setModelProviderBaseUrl(text, providerId, desiredBaseUrl),
  };
}

export function restoreModelProviderBaseUrl(
  text: string,
  providerId: string,
  originalBaseUrl: string | undefined,
): string {
  return setModelProviderBaseUrl(text, providerId, originalBaseUrl);
}

export function editRootConfig(
  text: string,
  desired: { chatgptBaseUrl: string; disableResponseStorage: boolean },
): CodexConfigEditResult {
  const original = inspectRootConfig(text);
  const newline = newlineOf(text);
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  let inRoot = true;
  let baseWritten = false;
  let storageWritten = false;
  const output: string[] = [];

  for (const line of lines) {
    if (inRoot && /^\s*\[/.test(line)) {
      if (!baseWritten) output.push(`chatgpt_base_url = ${encodeTomlString(desired.chatgptBaseUrl)}`);
      if (!storageWritten) output.push(`disable_response_storage = ${desired.disableResponseStorage}`);
      if (output.at(-1) !== "") output.push("");
      inRoot = false;
    }
    if (inRoot && /^\s*chatgpt_base_url\s*=/.test(line)) {
      if (!baseWritten) output.push(`chatgpt_base_url = ${encodeTomlString(desired.chatgptBaseUrl)}`);
      baseWritten = true;
      continue;
    }
    if (inRoot && /^\s*disable_response_storage\s*=/.test(line)) {
      if (!storageWritten) output.push(`disable_response_storage = ${desired.disableResponseStorage}`);
      storageWritten = true;
      continue;
    }
    output.push(line);
  }

  if (inRoot) {
    if (!baseWritten) output.push(`chatgpt_base_url = ${encodeTomlString(desired.chatgptBaseUrl)}`);
    if (!storageWritten) output.push(`disable_response_storage = ${desired.disableResponseStorage}`);
  }

  let editedText = output.join(newline);
  if (hadTrailingNewline && !editedText.endsWith(newline)) editedText += newline;
  return { original, editedText };
}

export function restoreRootConfig(text: string, original: RootConfigValues): string {
  const newline = newlineOf(text);
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  let inRoot = true;
  let baseHandled = false;
  let storageHandled = false;
  const output: string[] = [];

  for (const line of lines) {
    if (inRoot && /^\s*\[/.test(line)) {
      if (!baseHandled && original.chatgptBaseUrl !== undefined) {
        output.push(`chatgpt_base_url = ${encodeTomlString(original.chatgptBaseUrl)}`);
      }
      if (!storageHandled && original.disableResponseStorage !== undefined) {
        output.push(`disable_response_storage = ${original.disableResponseStorage}`);
      }
      inRoot = false;
    }
    if (inRoot && /^\s*chatgpt_base_url\s*=/.test(line)) {
      if (!baseHandled && original.chatgptBaseUrl !== undefined) {
        output.push(`chatgpt_base_url = ${encodeTomlString(original.chatgptBaseUrl)}`);
      }
      baseHandled = true;
      continue;
    }
    if (inRoot && /^\s*disable_response_storage\s*=/.test(line)) {
      if (!storageHandled && original.disableResponseStorage !== undefined) {
        output.push(`disable_response_storage = ${original.disableResponseStorage}`);
      }
      storageHandled = true;
      continue;
    }
    output.push(line);
  }

  let restored = output.join(newline).replace(new RegExp(`${newline}{3,}`, "g"), `${newline}${newline}`);
  if (hadTrailingNewline && !restored.endsWith(newline)) restored += newline;
  return restored;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function backupConfig(configFile: string, backupDir: string): Promise<string> {
  if (!(await pathExists(configFile))) throw new Error(`Codex config not found: ${configFile}`);
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = join(backupDir, `${basename(configFile)}.${stamp}.bak`);
  await copyFile(configFile, backupFile);
  return backupFile;
}

export async function writeCodexConfig(configFile: string, text: string): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await atomicWriteFile(configFile, text);
}

export async function readCodexConfig(configFile: string): Promise<string> {
  return readFile(configFile, "utf8");
}
