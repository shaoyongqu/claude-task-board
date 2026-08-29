import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { composerReferencePersistence } from "./composer-reference.mjs";
import { ApiError } from "./database.mjs";

const COMPOSER_CONTRACT_VERSION = "composer.v1";
const DEVICE_WORKSPACE_SESSION_PROBE_BYTES = 65_536;
const DEVICE_WORKSPACE_LIMIT = 50;

const VERIFIED_SLASH_ACTIONS = [
  {
    command: "/new",
    label: "New conversation",
    description: "Start a new conversation",
    handlerId: "new-conversation",
  },
  {
    command: "/model",
    label: "Model",
    description: "Choose the model",
    handlerId: "open-model-menu",
  },
  {
    command: "/reasoning",
    label: "Reasoning",
    description: "Choose the reasoning effort",
    handlerId: "open-reasoning-menu",
  },
];

const UNSUPPORTED_COMPOSER_SOURCES = [
  { kind: "apps", state: "unsupported", reasonCode: "INVOCATION_NAME_UNAVAILABLE" },
  { kind: "files", state: "unsupported", reasonCode: "ENCODER_UNSUPPORTED" },
  { kind: "plugins", state: "unsupported", reasonCode: "EXPERIMENTAL_SOURCE_NOT_ALLOWED" },
  { kind: "customPrompts", state: "unsupported", reasonCode: "NO_STABLE_CATALOG" },
];

const DEFAULT_MODELS = [
  {
    slug: "default",
    displayName: "Default",
    description: "The model configured in Claude Code",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    slug: "sonnet",
    displayName: "Sonnet",
    description: "Balanced quality and speed",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    slug: "opus",
    displayName: "Opus",
    description: "Highest capability",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    slug: "haiku",
    displayName: "Haiku",
    description: "Fastest responses",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
];

export function claudeHomeDirectory(env = process.env) {
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()) {
    return env.CLAUDE_CONFIG_DIR.trim();
  }
  return path.join(os.homedir(), ".claude");
}

const GLOBAL_PROJECT_ID = "local";
const TEMP_TASKS_WORKSPACE_DIR = "temp-tasks";

// PC-wide default root for project workspaces. Every board project without an
// explicit workspace works inside its own subdirectory here; the global
// "temporary tasks" project uses a dedicated sibling directory.
export function defaultWorkspaceRoot(env = process.env, home = os.homedir()) {
  const configured = env.CLAUDE_TASKBOARD_WORKSPACE_ROOT;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(home, "Claude Task Board", "workspaces");
}

export function sanitizeWorkspaceSegment(value) {
  const segment = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return segment || "project";
}

export function defaultProjectWorkspacePath({
  projectId,
  projectName,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const directory = projectId === GLOBAL_PROJECT_ID
    ? TEMP_TASKS_WORKSPACE_DIR
    : sanitizeWorkspaceSegment(projectName || projectId);
  return path.join(defaultWorkspaceRoot(env, home), directory);
}

export async function ensureWorkspaceDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return null;
  try {
    const parsed = yaml.load(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readMarkdownFrontmatter(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    return { frontmatter: parseFrontmatter(source), source };
  } catch {
    return { frontmatter: null, source: "" };
  }
}

async function collectFiles(directory, suffix) {
  const files = [];
  let pending = [directory];
  let available = false;
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
      available = true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(entryPath);
      }
    }
  }
  return { files: files.sort(), available };
}

// Claude Code treats the git root (or the working directory itself when the
// workspace is not a repository) as the project root, so project-level skills
// and agents are only read from there — never from unrelated ancestors such as
// the user's home directory.
async function projectClaudeFolders(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) return [];
  let current = path.resolve(workspacePath);
  const folders = [current];
  while (true) {
    try {
      await stat(path.join(current, ".git"));
      return [...new Set(folders)].map((directory) => path.join(directory, ".claude"));
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    folders.push(current);
  }
  return [path.join(path.resolve(workspacePath), ".claude")];
}

async function listSkillFiles(claudeHome, workspacePath) {
  const directories = [
    path.join(claudeHome, "skills"),
    ...(await projectClaudeFolders(workspacePath)).map((folder) => path.join(folder, "skills")),
  ];
  const skills = [];
  const identities = new Set();
  let available = false;
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
      available = true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(directory, entry.name);
      const definitionPath = path.join(skillPath, "SKILL.md");
      const { frontmatter } = await readMarkdownFrontmatter(definitionPath);
      const name = typeof frontmatter?.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : entry.name;
      const identity = `${name}\u0000${skillPath}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      skills.push({
        identity,
        stableId: name.normalize("NFC"),
        id: name.normalize("NFC"),
        name,
        path: skillPath,
        label: name,
        description: typeof frontmatter?.description === "string" && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : null,
        scope: directory.startsWith(claudeHome) ? "user" : "repo",
      });
    }
  }
  return { skills: skills.sort((left, right) => left.label.localeCompare(right.label)), available };
}

async function listAgentFiles(claudeHome, workspacePath) {
  const directories = [
    path.join(claudeHome, "agents"),
    ...(await projectClaudeFolders(workspacePath)).map((folder) => path.join(folder, "agents")),
  ];
  const agents = [];
  const identities = new Set();
  let available = false;
  for (const directory of directories) {
    const { files, available: layerAvailable } = await collectFiles(directory, ".md");
    available ||= layerAvailable;
    for (const filePath of files) {
      const { frontmatter, source } = await readMarkdownFrontmatter(filePath);
      const name = typeof frontmatter?.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : path.basename(filePath, ".md");
      const description = typeof frontmatter?.description === "string" && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : null;
      if (!description) continue;
      const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(source);
      const developerInstructions = bodyMatch && bodyMatch[1].trim() ? bodyMatch[1].trim() : null;
      const identity = `agent\u0000${name}\u0000${filePath}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      agents.push({
        identity,
        stableId: name.normalize("NFC"),
        name,
        label: name,
        description,
        developerInstructions,
        sourcePath: filePath,
      });
    }
  }
  return {
    agents: agents.sort((left, right) => left.label.localeCompare(right.label)),
    available,
  };
}

async function existingDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) return null;
  try {
    const resolved = await realpath(value.trim());
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function readSessionCwd(sessionPath) {
  try {
    const handle = await open(sessionPath, "r");
    try {
      const buffer = Buffer.alloc(DEVICE_WORKSPACE_SESSION_PROBE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (typeof record?.cwd === "string" && record.cwd.trim()) return record.cwd.trim();
        } catch {}
      }
    } finally {
      await handle.close();
    }
  } catch {}
  return null;
}

// Recent Claude Code working directories, recovered from the newest session
// file of each ~/.claude/projects/<slug> entry, plus every board project that
// still has a workspace on this device.
export async function loadDeviceWorkspaces(claudeHome, database) {
  const workspaces = new Map();

  try {
    const projectsDirectory = path.join(claudeHome, "projects");
    const entries = await readdir(projectsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || workspaces.size >= DEVICE_WORKSPACE_LIMIT) continue;
      const projectDirectory = path.join(projectsDirectory, entry.name);
      let sessionFiles;
      try {
        sessionFiles = (await readdir(projectDirectory, { withFileTypes: true }))
          .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"))
          .map((candidate) => path.join(projectDirectory, candidate.name));
      } catch {
        continue;
      }
      if (sessionFiles.length === 0) continue;
      let newest = null;
      for (const sessionFile of sessionFiles) {
        const mtimeMs = (await stat(sessionFile).catch(() => null))?.mtimeMs ?? 0;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: sessionFile, mtimeMs };
      }
      if (!newest) continue;
      const cwd = await readSessionCwd(newest.path);
      const workspacePath = cwd ? await existingDirectory(cwd) : null;
      if (workspacePath) workspaces.set(entry.name, workspacePath);
    }
  } catch {}

  if (database) {
    for (const project of await database.listProjects()) {
      if (workspaces.has(project.id)) continue;
      const workspacePath = await existingDirectory(project.workspacePath);
      if (workspacePath) workspaces.set(project.id, workspacePath);
    }
  }
  return workspaces;
}

async function loadMappedWorkspaces(projectMappings) {
  const workspaces = new Map();
  for (const [projectId, mappedPath] of Object.entries(projectMappings)) {
    const workspacePath = await existingDirectory(mappedPath);
    if (workspacePath) workspaces.set(projectId, workspacePath);
  }
  return workspaces;
}

function resolvedWorkspace(projectId, project, workspaces) {
  if (!project || project.id !== projectId) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const workspacePath = workspaces.get(projectId);
  if (!workspacePath) {
    throw new ApiError(
      409,
      "PROJECT_WORKSPACE_UNAVAILABLE",
      `Project '${projectId}' has no available device workspace`,
    );
  }
  return {
    workspacePath,
    addDirectories: [...new Set(workspaces.values())].filter((candidate) => candidate !== workspacePath),
    project,
  };
}

export async function resolveAiWorkspace(projectId, claudeHome, database) {
  const project = await database.getProject(projectId);
  const workspaces = await loadDeviceWorkspaces(claudeHome, database);
  if (project && !workspaces.has(projectId)) {
    // Initial state / legacy project without a workspace: fall back to the
    // PC-wide default directory so AI conversations keep working.
    const fallback = defaultProjectWorkspacePath({
      projectId: project.id,
      projectName: project.name,
    });
    await ensureWorkspaceDirectory(fallback);
    workspaces.set(projectId, fallback);
  }
  return resolvedWorkspace(projectId, project, workspaces);
}

export async function resolveMappedAiWorkspace(projectId, project, projectMappings = {}) {
  const workspaces = await loadMappedWorkspaces(projectMappings);
  return resolvedWorkspace(projectId, project, workspaces);
}

function sanitizeModels(value) {
  if (!Array.isArray(value)) throw new Error("Invalid Claude Code model catalog");
  return value.flatMap((model) => {
    if (
      !model
      || typeof model !== "object"
      || typeof model.slug !== "string"
      || !model.slug.trim()
    ) {
      return [];
    }
    const slug = model.slug.trim();
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? [...new Set(model.supportedReasoningEfforts.flatMap((effort) => (
          typeof effort === "string" && effort.trim() ? [effort.trim()] : []
        )))]
      : [];
    return [{
      slug,
      displayName: typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : slug,
      description: typeof model.description === "string" ? model.description : "",
      defaultReasoningEffort: typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort.trim()
        : (efforts[0] ?? ""),
      supportedReasoningEfforts: efforts,
      serviceTiers: [],
    }];
  });
}

export function configuredModels(env = process.env) {
  const configured = env.CLAUDE_TASKBOARD_MODELS;
  if (typeof configured !== "string" || !configured.trim()) return DEFAULT_MODELS;
  try {
    return sanitizeModels(JSON.parse(configured));
  } catch {
    return DEFAULT_MODELS;
  }
}

function composerCatalogSignature(skills, agents) {
  return JSON.stringify([...skills, ...agents].map(({
    identity,
    stableId,
    label,
    description,
    developerInstructions,
  }) => ({
    identity,
    stableId,
    label,
    description,
    developerInstructions,
  })));
}

function composerSources(skillsAvailable, agentsAvailable = true) {
  return [
    skillsAvailable
      ? { kind: "skills", state: "available", reasonCode: null }
      : { kind: "skills", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" },
    agentsAvailable
      ? { kind: "agents", state: "available", reasonCode: null }
      : { kind: "agents", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" },
    { kind: "slash", state: "available", reasonCode: null },
    ...UNSUPPORTED_COMPOSER_SOURCES,
  ];
}

export function composerCandidatesForSurface(
  response,
  surface = "ai-chat",
  issueSlashCommands = null,
  query = "",
) {
  if (surface === "ai-chat") return response;
  if (Array.isArray(issueSlashCommands)) {
    const unique = new Map();
    for (const command of issueSlashCommands) {
      if (
        !command
        || typeof command.id !== "string"
        || !/^[a-z][a-z0-9-]*$/.test(command.id)
        || typeof command.label !== "string"
        || !command.label.trim()
        || typeof command.description !== "string"
        || typeof command.insertText !== "string"
        || !command.insertText.startsWith(`/${command.id}`)
        || command.selectable === false
        || unique.has(command.id)
      ) continue;
      unique.set(command.id, command);
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const candidates = [...unique.values()].flatMap((command, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [command.id, command.label.replace(/^\//, "")],
        command.description,
      );
      if (matchScore < 0) return [];
      return [{
        kind: "slashAction",
        candidateRef: `slash:insert:${command.id}`,
        trigger: "/",
        label: command.label,
        description: command.description,
        group: "Commands",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        command: `/${command.id}`,
        insertionText: command.insertText,
        selection: { type: "insertText", text: command.insertText },
        matchScore,
      }];
    }).sort((left, right) => (
      right.matchScore - left.matchScore || left.itemOrder - right.itemOrder
    )).map(({ matchScore: _matchScore, ...candidate }) => candidate);
    return { ...response, candidates };
  }
  return {
    ...response,
    candidates: response.candidates.map((candidate) => {
      if (candidate.kind !== "slashAction") return candidate;
      const { dispatch: _dispatch, ...persistedCandidate } = candidate;
      return {
        ...persistedCandidate,
        selection: { type: "insertText", text: candidate.insertionText },
      };
    }),
  };
}

function composerMatchScore(query, primaryValues, description = "") {
  if (!query) return 0;
  const normalizedValues = primaryValues.map((value) => value.toLocaleLowerCase());
  const prefixLengths = normalizedValues
    .filter((value) => value.startsWith(query))
    .map((value) => value.length);
  if (prefixLengths.length > 0) return 1_000 - Math.min(...prefixLengths);
  if (normalizedValues.some((value) => value.includes(query))) return 500;
  return description.toLocaleLowerCase().includes(query) ? 100 : -1;
}

function referenceUnavailable(nodeIndex, reasonCode = "SOURCE_UNAVAILABLE") {
  return new ApiError(
    409,
    "COMPOSER_REFERENCE_UNAVAILABLE",
    "A selected composer reference is no longer available",
    { nodeIndex, reasonCode },
  );
}

export class ComposerCatalog {
  constructor({ claudeHome, issueSlashCommands } = {}) {
    this.claudeHome = claudeHome ?? claudeHomeDirectory();
    this.issueSlashCommands = issueSlashCommands ?? null;
    this.workspaces = new Map();
  }

  async candidatesForSurface(response, { surface, trigger, query }) {
    if (surface === "ai-chat" || trigger !== "/") {
      return composerCandidatesForSurface(response, surface);
    }
    if (!this.issueSlashCommands) {
      return {
        ...response,
        candidates: [],
        sources: response.sources.map((source) => (
          source.kind === "slash"
            ? { kind: "slash", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" }
            : source
        )),
      };
    }
    try {
      const commands = await this.issueSlashCommands();
      return composerCandidatesForSurface(response, surface, commands, query);
    } catch {
      return {
        ...response,
        candidates: [],
        sources: response.sources.map((source) => (
          source.kind === "slash"
            ? { kind: "slash", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" }
            : source
        )),
      };
    }
  }

  invalidate() {
    this.workspaces.clear();
  }

  close() {
    this.workspaces.clear();
  }

  async #scanWorkspace(workspacePath) {
    const { skills, available: skillsAvailable } = await listSkillFiles(this.claudeHome, workspacePath);
    const { agents, available: agentsAvailable } = await listAgentFiles(this.claudeHome, workspacePath);
    return {
      skills: skills.map((skill) => ({ ...skill, identity: `${skill.name}\u0000${skill.path}` })),
      skillsAvailable,
      agents,
      agentsAvailable,
    };
  }

  async candidates({ workspacePath, trigger, query }) {
    const scanned = await this.#scanWorkspace(workspacePath);
    const workspaceKey = workspacePath ?? "__global__";
    const state = this.#acceptCatalog(
      workspaceKey,
      scanned.skills,
      scanned.agents,
    );
    const normalizedQuery = query.toLocaleLowerCase();
    const skillIdentityCounts = new Map();
    for (const skill of state.skills) {
      skillIdentityCounts.set(skill.stableId, (skillIdentityCounts.get(skill.stableId) ?? 0) + 1);
    }
    const skillCandidates = trigger === "@" ? state.skills.flatMap((skill, itemOrder) => {
      if (skillIdentityCounts.get(skill.stableId) !== 1) return [];
      const matchScore = composerMatchScore(
        normalizedQuery,
        [skill.label, skill.name],
        skill.description ?? "",
      );
      if (matchScore < 0) return [];
      return [{
        kind: "skill",
        candidateRef: state.refs.get(skill.identity),
        trigger,
        label: skill.label,
        description: skill.description,
        group: "Skills",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        persistence: composerReferencePersistence("skill", skill.stableId, skill.label),
        matchScore,
      }];
    }) : [];
    const agentCandidates = trigger === "@" ? state.agents.flatMap((agent, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [agent.label, agent.stableId],
        agent.description ?? "",
      );
      if (matchScore < 0) return [];
      return [{
        kind: "agent",
        candidateRef: state.refs.get(agent.identity),
        trigger,
        label: agent.label,
        description: agent.description,
        group: "Agents",
        groupOrder: 1,
        itemOrder,
        selectable: true,
        insertionText: `@${agent.name}`,
        persistence: composerReferencePersistence("agent", agent.stableId, agent.label),
        matchScore,
      }];
    }) : [];
    const slashCandidates = trigger === "/" ? VERIFIED_SLASH_ACTIONS.flatMap((action, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [action.command.slice(1), action.label],
        action.description,
      );
      if (matchScore < 0) return [];
      return [{
        kind: "slashAction",
        candidateRef: `slash:${action.handlerId}`,
        trigger,
        label: action.label,
        description: action.description,
        group: "Commands",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        command: action.command,
        insertionText: action.command,
        dispatch: { type: "client", handlerId: action.handlerId },
        matchScore,
      }];
    }) : [];
    const candidates = [...skillCandidates, ...agentCandidates, ...slashCandidates]
      .sort((left, right) => (
        right.matchScore - left.matchScore
        || left.groupOrder - right.groupOrder
        || left.itemOrder - right.itemOrder
      ))
      .map(({ matchScore: _matchScore, ...candidate }) => candidate);
    return {
      contractVersion: COMPOSER_CONTRACT_VERSION,
      revision: state.revision,
      candidates,
      sources: composerSources(scanned.skillsAvailable, scanned.agentsAvailable),
    };
  }

  async rebindPersistedReferences({ workspacePath, nodes }) {
    const scanned = await this.#scanWorkspace(workspacePath);
    const state = this.#acceptCatalog(workspaceKey(workspacePath), scanned.skills, scanned.agents);
    const sources = composerSources(scanned.skillsAvailable, scanned.agentsAvailable);
    const byStableIdentity = new Map();
    for (const item of state.skills) {
      const key = `skill\u0000${item.stableId}`;
      const matches = byStableIdentity.get(key) ?? [];
      matches.push(item);
      byStableIdentity.set(key, matches);
    }
    for (const item of state.agents) {
      const key = `agent\u0000${item.stableId}`;
      const matches = byStableIdentity.get(key) ?? [];
      matches.push(item);
      byStableIdentity.set(key, matches);
    }

    const reboundNodes = [];
    const bindings = [];
    let ready = true;
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.type === "text") {
        reboundNodes.push(node);
        continue;
      }
      if (node.type === "unsupportedReference") {
        ready = false;
        bindings.push({
          nodeIndex,
          status: "unavailable",
          referenceKind: "unsupported",
          reasonCode: node.reasonCode,
        });
        continue;
      }
      const matches = byStableIdentity.get(`${node.referenceKind}\u0000${node.stableId}`) ?? [];
      let reasonCode = null;
      if (node.referenceKind === "skill" && !scanned.skillsAvailable) {
        reasonCode = "SOURCE_UNAVAILABLE";
      } else if (node.referenceKind === "agent" && !scanned.agentsAvailable) {
        reasonCode = "SOURCE_UNAVAILABLE";
      } else if (matches.length === 0) {
        reasonCode = "REFERENCE_NOT_FOUND";
      } else if (matches.length > 1) {
        reasonCode = "REFERENCE_AMBIGUOUS";
      }
      if (reasonCode) {
        ready = false;
        bindings.push({
          nodeIndex,
          status: "unavailable",
          referenceKind: node.referenceKind,
          reasonCode,
        });
        continue;
      }
      const reference = matches[0];
      bindings.push({
        nodeIndex,
        status: "resolved",
        referenceKind: node.referenceKind,
        label: reference.label,
      });
      reboundNodes.push({
        type: node.referenceKind,
        candidateRef: state.refs.get(reference.identity),
        label: reference.label,
      });
    }
    return {
      contractVersion: COMPOSER_CONTRACT_VERSION,
      ready,
      revision: state.revision,
      ...(ready ? { document: { version: 1, nodes: reboundNodes } } : {}),
      bindings,
      sources,
      diagnostics: [],
    };
  }

  async resolveReferences({ workspacePath, revision, nodes }) {
    const scanned = await this.#scanWorkspace(workspacePath);
    const current = this.#acceptCatalog(workspaceKey(workspacePath), scanned.skills, scanned.agents);
    const firstReferenceIndex = nodes.findIndex((node) => (
      node.type === "skill" || node.type === "agent"
    ));
    if (revision !== undefined && current.revision !== revision) {
      throw referenceUnavailable(Math.max(firstReferenceIndex, 0));
    }

    const byRef = new Map([...current.skills, ...current.agents].map((item) => (
      [current.refs.get(item.identity), item]
    )));
    return nodes.map((node, nodeIndex) => {
      if (node.type !== "skill" && node.type !== "agent") return null;
      const reference = byRef.get(node.candidateRef);
      if (!reference) throw referenceUnavailable(nodeIndex);
      return reference;
    });
  }

  async resolveSkills(options) {
    return this.resolveReferences(options);
  }

  #acceptCatalog(workspaceKeyValue, skills, agents) {
    const signature = composerCatalogSignature(skills, agents);
    const current = this.workspaces.get(workspaceKeyValue);
    if (current?.signature === signature) return current;
    const refs = new Map([...skills, ...agents].map((item) => [item.identity, randomUUID()]));
    const state = { revision: randomUUID(), signature, skills, agents, refs };
    this.workspaces.set(workspaceKeyValue, state);
    return state;
  }
}

function workspaceKey(workspacePath) {
  return workspacePath ?? "__global__";
}

// Slash commands available on the issue composer surface: markdown command
// files from ~/.claude/commands and the workspace .claude/commands.
export async function loadSlashCommands(claudeHome = claudeHomeDirectory(), workspacePath = null) {
  const directories = [
    path.join(claudeHome, "commands"),
    ...(await projectClaudeFolders(workspacePath)).map((folder) => path.join(folder, "commands")),
  ];
  const commands = [];
  const seen = new Set();
  for (const directory of directories) {
    const { files } = await collectFiles(directory, ".md");
    for (const filePath of files) {
      const id = path.basename(filePath, ".md").toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(id) || seen.has(id)) continue;
      const { frontmatter } = await readMarkdownFrontmatter(filePath);
      const description = typeof frontmatter?.description === "string" && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : `Run the ${id} command`;
      seen.add(id);
      commands.push({
        id,
        label: `/${id}`,
        description,
        insertText: `/${id} `,
      });
    }
  }
  return commands;
}

export async function discoverAiCatalog({ workspacePath, claudeHome, processEnv = process.env }) {
  const home = claudeHome ?? claudeHomeDirectory(processEnv);
  const { skills } = await listSkillFiles(home, workspacePath);
  const commands = await loadSlashCommands(home, workspacePath);
  return {
    models: configuredModels(processEnv),
    skills: skills.map((skill) => ({
      id: skill.id,
      label: skill.label,
      description: skill.description ?? "",
      path: skill.path,
      scope: skill.scope,
    })),
    commands,
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  };
}
