import log from "log";
import { groupByPath, type GitLabRef } from "gitlabRef";

namespace gitlab {

    export const apiToken = Bun.env.GITLAB_TOKEN;
    export const domain = Bun.env.GITLAB_DOMAIN;

    /** Written into Zendesk when GitLab reports no value. */
    export const NONE = "None";

    /** The state of a GitLab work item, as reflected onto a Zendesk ticket. */
    export interface PropsForZendesk {
        /** Canonical reference, e.g. "nuodb/server/nuodb#14509". */
        ref: string;
        /** Work item type name, e.g. "Customer Support Request", "Bug". */
        type: string;
        /** Status widget value, e.g. "Open", "Untriaged", "Done", "Not a bug". */
        status: string;
    }

    interface WorkItemNode {
        iid: string;
        state: string;
        widgets: { status?: { name: string } | null }[];
        workItemType: { name: string };
    }

    /**
     * Fields requested per work item.
     *
     * Descriptions and labels are not requested: nothing is synced from them and
     * descriptions run to several KB each.
     */
    const NODE_FIELDS = `
        iid
        state
        workItemType { name }
        widgets {
            ... on WorkItemWidgetStatus { status { name } }
        }`;

    async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const response = await fetch(`${domain}/api/graphql`, {
            method: "POST",
            headers: {
                "PRIVATE-TOKEN": `${apiToken}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({ query, variables }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GitLab fetch failed: ${response.status} ${errorText}`);
        }

        const body = await response.json() as { data?: T, errors?: { message: string }[] };
        if (body.errors?.length) {
            throw new Error(`GitLab GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
        }
        if (!body.data) throw new Error("GitLab GraphQL returned no data");
        return body.data;
    }

    function toProps(ref: GitLabRef, node: WorkItemNode): PropsForZendesk {
        // Epics carry no Status widget, so fall back to open/closed rather than
        // reporting "None" for every group level item.
        const status = node.widgets.find((w) => w.status)?.status?.name
            ?? (node.state ? node.state[0] + node.state.slice(1).toLowerCase() : undefined);

        return {
            ref: ref.ref,
            type: node.workItemType.name,
            status: status ?? NONE,
        };
    }

    /**
     * Fetch the current state of the given work items.
     *
     * Refs are grouped by namespace and each namespace becomes one alias in a
     * GraphQL request. Namespaces are batched a few at a time to stay under
     * GitLab's per-query complexity limit, so this may take more than one
     * round trip. Merge request and epic refs are logged and skipped.
     */
    export async function getWorkItems(refs: GitLabRef[]): Promise<PropsForZendesk[]> {
        // Epics are group level work items and resolve through the same query.
        // Merge requests are a different GraphQL type and are not synced.
        const workItemRefs = refs.filter((r) => r.kind !== "merge_request");
        const skipped = refs.filter((r) => r.kind === "merge_request");
        if (skipped.length > 0) {
            log("Skipping merge request references:", skipped.map((r) => r.ref));
        }
        if (workItemRefs.length === 0) return [];

        const byPath = groupByPath(workItemRefs);
        const paths = Array.from(byPath.keys());

        // A returned node carries only its iid, so map it back to the reference
        // that asked for it: an epic's canonical ref uses "&", not "#".
        const refByKey = new Map(workItemRefs.map((r) => [`${r.fullPath}:${r.iid}`, r]));

        // Each path costs ~122 GraphQL complexity points because both project and
        // group aliases are queried (nothing in a pasted link says which one it
        // is; the wrong one comes back null). GitLab caps queries at 250, so more
        // than 2 paths in one request gets rejected outright. Batching keeps this
        // working regardless of how many distinct namespaces tickets reference.
        const PATHS_PER_REQUEST = 2;
        const items: PropsForZendesk[] = [];
        for (let start = 0; start < paths.length; start += PATHS_PER_REQUEST) {
            const batch = paths.slice(start, start + PATHS_PER_REQUEST);

            const params = batch
                .flatMap((_, i) => [`$path${i}: ID!`, `$iids${i}: [String!]`])
                .join(", ");
            const aliases = batch
                .map((_, i) => `
                p${i}: project(fullPath: $path${i}) {
                    workItems(iids: $iids${i}) { nodes { ${NODE_FIELDS} } }
                }
                g${i}: group(fullPath: $path${i}) {
                    workItems(iids: $iids${i}) { nodes { ${NODE_FIELDS} } }
                }`)
                .join("");

            const variables: Record<string, unknown> = {};
            batch.forEach((path, i) => {
                variables[`path${i}`] = path;
                variables[`iids${i}`] = byPath.get(path)!.map((r) => String(r.iid));
            });

            const data = await graphql<Record<string, { workItems: { nodes: WorkItemNode[] } } | null>>(
                `query(${params}) {${aliases}\n}`,
                variables,
            );

            batch.forEach((path, i) => {
                const namespace = data[`p${i}`] ?? data[`g${i}`];
                if (!namespace) {
                    log(`ERROR: namespace not found or not visible to this token: ${path}`);
                    return;
                }
                for (const node of namespace.workItems.nodes) {
                    const ref = refByKey.get(`${path}:${node.iid}`);
                    if (ref) items.push(toProps(ref, node));
                }
            });
        }

        const found = new Set(items.map((i) => i.ref));
        const missing = workItemRefs.filter((r) => !found.has(r.ref)).map((r) => r.ref);
        if (missing.length > 0) log("Work items referenced by tickets but not returned by GitLab:", missing);

        return items;
    }
}

export default gitlab;
