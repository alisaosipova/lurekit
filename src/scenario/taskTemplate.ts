// Task placeholders (evidence-spec §4.1 "Task placeholders", ADR-0002 interface notes).
// A scenario task is static, but fixture content lives at a per-run location. A task may name
// it with `{{env.NAME}}` (merged profile env) or `{{canary.KEY}}` (detector canaries). The
// runner renders the task after provisioning; nothing here touches the agent.

/** One well-formed placeholder. Global: use with matchAll/replace only. */
const PLACEHOLDER = /\{\{(env|canary)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
/** Any brace-delimited sequence, well-formed or not (for the loader lint). */
const ANY_BRACES = /\{\{[^}]*\}\}/g;

export type PlaceholderSource = 'env' | 'canary';

export interface TaskValues {
  env?: Record<string, string | undefined>;
  canaries?: Record<string, string | undefined>;
}

export interface RenderedTask {
  /** The task with every resolvable placeholder substituted. Only meaningful when
   *  `unresolved` is empty; never send it to an agent otherwise. */
  text: string;
  /** Placeholders that had no value (or whose value itself contains `{{`), verbatim, deduped,
   *  in order of first appearance. */
  unresolved: string[];
}

/** Render a task in a single pass: a substituted value is never re-expanded. */
export function renderTask(task: string, values: TaskValues): RenderedTask {
  const unresolved: string[] = [];
  const text = task.replace(PLACEHOLDER, (whole, source: PlaceholderSource, name: string) => {
    const table = source === 'env' ? values.env : values.canaries;
    const value = table && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
    if (typeof value !== 'string' || value.length === 0 || value.includes('{{')) {
      if (!unresolved.includes(whole)) unresolved.push(whole);
      return whole;
    }
    return value;
  });
  return { text, unresolved };
}

/** Loader lint: every `{{...}}` in a task must be a well-formed placeholder. Returns the
 *  malformed sequences (empty => ok). A stray `{{` with no closing `}}` is also reported. */
export function malformedPlaceholders(task: string): string[] {
  const bad: string[] = [];
  for (const m of task.matchAll(ANY_BRACES)) {
    const ok = new RegExp(`^${PLACEHOLDER.source}$`).test(m[0]);
    if (!ok) bad.push(m[0]);
  }
  const stripped = task.replace(ANY_BRACES, '');
  if (stripped.includes('{{') || stripped.includes('}}')) bad.push('unbalanced {{ or }}');
  return bad;
}

/** The placeholders a task references, verbatim, deduped. */
export function placeholdersIn(task: string): string[] {
  const out: string[] = [];
  for (const m of task.matchAll(PLACEHOLDER)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}
