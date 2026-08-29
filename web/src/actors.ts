import type { ActorIdentity, AssigneeTarget } from "./types";

export const CLAUDE_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "claude-agent",
  name: "Claude Agent",
  avatarUrl: null,
};

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return target === "claude-agent" ? CLAUDE_AGENT_ACTOR : currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") return "claude-agent";
  return actor.id === currentUser.id ? "current-user" : undefined;
}
