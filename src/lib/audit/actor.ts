/*
 * Who changes a setting: an admin on a page, the operator on the command line
 * (`cli`, docs/deployment.md), or the one-time import of variables that moved
 * out of the environment. The operator and the import are objects with a
 * symbol, which no request can carry: Server Actions build their actor from
 * the session, and JSON drops symbols.
 */

const OPERATOR = Symbol("logbook.operator");
const ENVIRONMENT = Symbol("logbook.environment");

/** Whoever runs an operator command on the server, with an admin's rights. */
export interface Operator {
  readonly [OPERATOR]: true;
  /** The command for the audit log, without values, e.g. "cli settings apply slack". */
  readonly command: string;
}

/** A process that copies variables from its environment into the database once. */
export interface EnvironmentImport {
  readonly [ENVIRONMENT]: true;
  /** The variables' names, never their values. */
  readonly variables: readonly string[];
}

/** An admin signed in to Logbook. */
export interface AdminActor {
  readonly personId: string;
}

export type SettingsActor = AdminActor | Operator | EnvironmentImport;

/** The operator running `command`. Only the command line (src/cli) creates one. */
export function operator(command: string): Operator {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is Operator {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}

/** The import of `variables`. Only moved-variables.ts creates one. */
export function environmentImport(variables: readonly string[]): EnvironmentImport {
  return { [ENVIRONMENT]: true, variables: [...variables] };
}

export function isEnvironmentImport(actor: unknown): actor is EnvironmentImport {
  return typeof actor === "object" && actor !== null && ENVIRONMENT in actor;
}

/** The person to record, if any, and how the audit payload names the actor. */
export function auditActor(actor: SettingsActor): { actorId: string | null; payload: Record<string, unknown> } {
  if (isOperator(actor)) return { actorId: null, payload: { actor: "operator", command: actor.command } };
  if (isEnvironmentImport(actor)) return { actorId: null, payload: { actor: "environment", variables: [...actor.variables] } };
  return { actorId: actor.personId, payload: {} };
}
