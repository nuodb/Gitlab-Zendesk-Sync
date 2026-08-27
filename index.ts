import zendesk from "zendesk";
import log from "log";
import assert from "assert";
import gitlab from "gitlab";
import type { GitLabRef } from "gitlabRef";


log("Bun.env.ENV type:", Bun.env.NODE_ENV);
log("Bun.env.ZENDESK_DOMAIN:", Bun.env.ZENDESK_DOMAIN);
log("Bun.env.GITLAB_DOMAIN:", Bun.env.GITLAB_DOMAIN);


function validateEnv() {
    const requiredVars = [
        'ZENDESK_DOMAIN', 'ZENDESK_OAUTH_CLIENT_ID', 'ZENDESK_OAUTH_CLIENT_SECRET',
        'GITLAB_DOMAIN', 'GITLAB_TOKEN',
        'GITLAB_WORK_ITEM_FIELD_ID', 'GITLAB_TYPE_FIELD_ID', 'GITLAB_STATUS_FIELD_ID'
    ];
    const missing = requiredVars.filter((v) => !Bun.env[v]);
    if (missing.length > 0) {
        log(`Missing required environment variables: ${missing.join(", ")}`);
        throw new Error("Missing required environment variables");
    }
}

/** DRY_RUN=true logs the intended Zendesk writes and sends nothing. */
const dryRun = Bun.env.DRY_RUN === "true";

let isSyncing = false;
let cycle = 0;

/**
 * One sync cycle.
 *
 * Every tracked work item is refetched in a single GraphQL request and compared
 * against what each ticket already holds, so there is no cache to drift: a
 * restart or a manual edit in Zendesk resolves itself on the next pass.
 */
async function pollAndSync() {
    cycle++;
    if (isSyncing) {
        log(`Sync already in progress, skipping cycle`, "#" + cycle);
        return;
    }

    isSyncing = true;
    const start = Date.now();

    try {
        log("Starting sync cycle", "#" + cycle);

        const tickets = await zendesk.getTickets();
        if (tickets.length === 0) {
            log("No tickets with a GitLab Work Item set.");
            return;
        }

        // Resolve each ticket's field value to a work item reference.
        const refByTicketId = new Map<number, GitLabRef>();
        const unparseable: number[] = [];
        for (const ticket of tickets) {
            assert(ticket.id);
            const ref = zendesk.getGitLabRef(ticket);
            if (ref) refByTicketId.set(ticket.id, ref);
            else unparseable.push(ticket.id);
        }
        if (unparseable.length > 0) {
            log("Tickets whose GitLab Work Item field is not a work item reference:", unparseable);
        }
        if (refByTicketId.size === 0) return;

        // Many tickets can point at the same work item.
        const uniqueRefs = Array.from(
            new Map(Array.from(refByTicketId.values()).map((r) => [r.ref, r])).values()
        );
        log("Work items to get:", uniqueRefs.map((r) => r.ref));

        const items = await gitlab.getWorkItems(uniqueRefs);
        const itemByRef = new Map(items.map((i) => [i.ref, i]));

        // Write only the tickets whose current values differ from GitLab's.
        const ticketsToUpdate: zendesk.ZendeskUpdateTicket[] = [];
        for (const ticket of tickets) {
            assert(ticket.id);
            const ref = refByTicketId.get(ticket.id);
            if (!ref) continue;

            const item = itemByRef.get(ref.ref);
            if (!item) continue;   // already logged as missing by getWorkItems

            const currentType = zendesk.getCustomFieldValue(ticket, zendesk.gitlabTypeFieldId);
            const currentStatus = zendesk.getCustomFieldValue(ticket, zendesk.gitlabStatusFieldId);
            if (currentType === item.type && currentStatus === item.status) continue;

            ticketsToUpdate.push({
                id: ticket.id,
                custom_fields: [{
                    id: zendesk.gitlabTypeFieldId,
                    value: item.type,
                }, {
                    id: zendesk.gitlabStatusFieldId,
                    value: item.status,
                }]
            });
        }

        if (ticketsToUpdate.length === 0) {
            log("All tickets already match their work items.");
        } else if (dryRun) {
            log(`DRY RUN: would update ${ticketsToUpdate.length} ticket(s), sending nothing to Zendesk:`);
            for (const t of ticketsToUpdate) {
                const fields = t.custom_fields.map((f) => `${f.id}=${JSON.stringify(f.value)}`).join(" ");
                log(`  ticket ${t.id}: ${fields}`);
            }
        } else {
            await zendesk.updateTickets(ticketsToUpdate);
        }

        log(`Sync cycle #${cycle} completed in ${Date.now() - start}ms.`);
        log("==============================================");

    } catch (err) {
        log(`Error in pollAndSync: ${err instanceof Error ? err.stack : err}`);
    } finally {
        isSyncing = false;
    }
}


async function main() {
    try {
        validateEnv();
        log("Starting the NuoDB GitLab to Zendesk Sync Server...");
        if (dryRun) log("DRY RUN mode: no writes will be sent to Zendesk.");

        await pollAndSync();

        const INTERVAL = 30 * 1000;
        setInterval(pollAndSync, INTERVAL); // every 30 seconds

    } catch (err) {
        log(`Startup error: ${err instanceof Error ? err.stack : err}`);
    }
}

main();
