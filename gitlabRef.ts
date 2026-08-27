/**
 * Parsing of GitLab work item references pasted into the Zendesk custom field.
 *
 * An iid is only unique within a namespace, so the namespace path must be kept
 * or the reference cannot be resolved.
 */

export type GitLabRefKind = "work_item" | "merge_request" | "epic";

export interface GitLabRef {
    /** Namespace path, e.g. "platform/backend" or "platform/sub/backend" */
    fullPath: string;
    kind: GitLabRefKind;
    /** Per-namespace internal id, e.g. 123 */
    iid: number;
    /** Canonical GitLab reference syntax, e.g. "platform/backend#123". Cache key. */
    ref: string;
}

const SIGIL: Record<GitLabRefKind, string> = {
    work_item: "#",
    merge_request: "!",
    epic: "&",
};

/** GitLab serves work items at both /-/issues/N and /-/work_items/N. */
const KIND_BY_SEGMENT: Record<string, GitLabRefKind> = {
    issues: "work_item",
    work_items: "work_item",
    merge_requests: "merge_request",
    epics: "epic",
};

const SHORT_FORM = /^([A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)+)([#!&])(\d+)$/;

/** Finds links inside a field that also contains other text. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'()]+/g;

function build(fullPath: string, kind: GitLabRefKind, iid: number): GitLabRef {
    return { fullPath, kind, iid, ref: `${fullPath}${SIGIL[kind]}${iid}` };
}

/**
 * Treat a short internal hostname and its fully qualified form as the same host,
 * in either direction, since agents paste both.
 *
 * This is a sanity check on the link, not a security boundary: the parsed
 * reference is always queried against GITLAB_DOMAIN, and the host in the pasted
 * URL is never contacted.
 */
function hostMatches(actual: string, expected: string): boolean {
    const a = actual.toLowerCase();
    const e = expected.toLowerCase();
    return a === e || a.startsWith(`${e}.`) || e.startsWith(`${a}.`);
}

/**
 * Parse whatever an agent pasted into the Zendesk field.
 *
 * Accepts full URLs (`/-/work_items/123`, `/-/issues/123`, `/-/merge_requests/45`,
 * `/groups/g/-/epics/7`) and hand-typed reference syntax (`group/project#123`).
 *
 * @param raw   The raw custom field value.
 * @param host  Expected host, e.g. "nuohub". When given, URLs on any other host
 *              are rejected. Omit to accept any host.
 * @returns null when the value is not a GitLab reference. Callers skip those tickets.
 */
export function parseRef(raw: unknown, host?: string): GitLabRef | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (value === "") return null;

    const direct = parseOne(value, host);
    if (direct) return direct;

    // The field sometimes holds a link alongside other text, e.g. an old tracker
    // key and a URL. Fall back to the first link in the value that parses.
    for (const candidate of value.match(URL_IN_TEXT) ?? []) {
        const embedded = parseOne(candidate, host);
        if (embedded) return embedded;
    }

    return null;
}

function parseOne(value: string, host?: string): GitLabRef | null {
    const short = value.match(SHORT_FORM);
    if (short) {
        const [, fullPath, sigil, iid] = short as unknown as [string, string, string, string];
        const kind = (Object.keys(SIGIL) as GitLabRefKind[]).find((k) => SIGIL[k] === sigil)!;
        return build(fullPath, kind, Number(iid));
    }

    if (!value.includes("/-/")) return null;

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (host && !hostMatches(url.host, host)) return null;

    // Left of /-/ is the namespace, right is <segment>/<iid>[/extra].
    const separator = url.pathname.indexOf("/-/");
    const left = url.pathname.slice(0, separator);
    const right = url.pathname.slice(separator + "/-/".length);

    // Group-level URLs are prefixed with /groups/; project URLs are not.
    const fullPath = decodeURIComponent(left)
        .replace(/^\/(?:groups\/)?/, "")
        .replace(/\/+$/, "");
    if (fullPath === "") return null;

    const parts = right.split("/").filter(Boolean);
    const segment = parts[0];
    const rawIid = parts[1];
    if (!segment || !rawIid) return null;

    const kind = KIND_BY_SEGMENT[segment];
    if (!kind) return null;

    if (!/^\d+$/.test(rawIid)) return null;
    const iid = Number(rawIid);
    if (iid <= 0) return null;

    return build(fullPath, kind, iid);
}

/** Group refs by namespace so each project needs only one GraphQL alias. */
export function groupByPath(refs: GitLabRef[]): Map<string, GitLabRef[]> {
    const byPath = new Map<string, GitLabRef[]>();
    for (const ref of refs) {
        const existing = byPath.get(ref.fullPath);
        if (existing) existing.push(ref);
        else byPath.set(ref.fullPath, [ref]);
    }
    return byPath;
}
