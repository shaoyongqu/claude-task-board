import { cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(projectRoot, "skills", "manage-taskboard");
const claudeHome = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR.trim())
  : path.join(os.homedir(), ".claude");
const targetDirectory = path.join(claudeHome, "skills", "manage-taskboard");

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(path.dirname(targetDirectory), { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });

console.log(`Installed manage-taskboard skill to ${targetDirectory}`);
