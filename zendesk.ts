import log from "log";
import type { components, paths } from "zendesk-openapi";
import createClient from "openapi-fetch";
import assert from "assert";
import { parseRef, type GitLabRef } from "gitlabRef";

// aliasing global fetch to avoid collision with zendesk.fetch
const ftch = fetch;

namespace zendesk {

    export const gitlabWorkItemFieldId = Number(Bun.env.GITLAB_WORK_ITEM_FIELD_ID);  // "GitLab Work Item" field
    export const gitlabTypeFieldId = Number(Bun.env.GITLAB_TYPE_FIELD_ID);  // "GitLab Type" field
    export const gitlabStatusFieldId = Number(Bun.env.GITLAB_STATUS_FIELD_ID);  // "GitLab Status" field

    /** Host of the GitLab instance, used to reject links to anywhere else. */
    const gitlabHost = (() => {
        try {
            return new URL(`${Bun.env.GITLAB_DOMAIN}`).host;
        } catch {
            return undefined;
        }
    })();

    /**
     * OAuth client_credentials auth.
     *
     * Access tokens expire after 30 minutes, so they are minted on demand and
     * cached; only the client id and secret are configured.
     *
     * The token acts as the OAuth client's owner, and that identity is load
     * bearing: the Zendesk trigger that posts the internal note fires on
     * "Current user is <that user> and Update via is Web service (API)".
     * Changing the client's owner changes which updates produce a note.
     */
    const OAUTH_SCOPES = "tickets:read tickets:write read write";

    /** Mint a new token this many ms before the current one actually expires. */
    const EXPIRY_MARGIN_MS = 60_000;

    let cachedToken: { value: string, expiresAt: number } | undefined;

    export async function getAccessToken(forceRefresh = false): Promise<string> {
        if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
            return cachedToken.value;
        }

        const response = await ftch(`${Bun.env.ZENDESK_DOMAIN}/oauth/tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: `${Bun.env.ZENDESK_OAUTH_CLIENT_ID}`,
                client_secret: `${Bun.env.ZENDESK_OAUTH_CLIENT_SECRET}`,
                scope: OAUTH_SCOPES,
            }),
        });

        if (!response.ok) {
            throw new Error(`Zendesk token request failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { access_token: string, expires_in: number };
        cachedToken = {
            value: data.access_token,
            expiresAt: Date.now() + (data.expires_in * 1000) - EXPIRY_MARGIN_MS,
        };
        log(`Minted Zendesk access token, valid for ${data.expires_in}s`);
        return cachedToken.value;
    }

    /** Drop the cached token so the next request mints a fresh one. */
    function invalidateToken() {
        cachedToken = undefined;
    }

    export const client = createClient<paths>({
        baseUrl: `${Bun.env.ZENDESK_DOMAIN}`,
        headers: {
            'Content-Type': "application/json",
            // Without this the search endpoint answers 415 rather than JSON.
            "Accept": "application/json",
        }
    });

    client.use({
        async onRequest({ request }) {
            request.headers.set("Authorization", `Bearer ${await getAccessToken()}`);
            return request;
        },
        async onResponse({ response }) {
            // A token revoked early still 401s despite the expiry margin.
            if (response.status === 401) invalidateToken();
            return response;
        },
    });


    export interface ZendeskResponse {
        ok: boolean,
        url: string,
        status: number,
        statusText: string,
        redirected: boolean,
        bodyUsed: boolean,
        json: () => any
    };



    export interface TicketsResponse {
        readonly count?: number;
        readonly facets?: string | null;
        readonly next_page?: string | null;
        readonly previous_page?: string | null;
        results?: (
            components["schemas"]["SearchResultObject"]
            & { custom_fields: { id: number, value: any }[] }
        )[];
    }

    export async function fetch(input: string | Request, init?: Omit<BunFetchRequestInit, 'headers'>): Promise<ZendeskResponse> {
        const send = async (token: string) => await ftch(`${Bun.env.ZENDESK_DOMAIN}${input}`, {
            headers: {
                'Content-Type': "application/json",
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`
            },
            ...init
        }) as unknown as ZendeskResponse;

        let response = await send(await getAccessToken());
        if (response.status === 401) {
            // Token revoked or expired early; mint a fresh one and try once more.
            invalidateToken();
            response = await send(await getAccessToken(true));
        }
        return response;
    }

    export async function getTicket(ticketId: number) {
        const { data, error } = await client.GET(`/api/v2/tickets/{ticket_id}`, {
            params: {
                path: { ticket_id: ticketId }
            }
        });

        error && log("erred", error);
        assert(data && data.ticket, "failed to get the ticket by id " + ticketId);
        const { ticket } = data;

        return ticket
    }

    const defaultTicket = {
        ticket: {
            subject: "Ticket for testing gitlab to zendesk sync server",
            comment: {
                body: "pass a ticket to createTicket function if desired to set a first specific comment"
            },
            priority: "normal",
        }
    };

    export async function createTicket(ticket: typeof defaultTicket = defaultTicket): Promise<components["schemas"]["TicketObject"]> {
        const body = JSON.stringify(ticket);

        const response = await fetch("/api/v2/tickets", {
            method: "POST",
            body,
        });
        if (!response.ok) {
            throw new Error(`Failed to create ticket: ${response.statusText}`);
        }

        const data = await response.json();
        assert(data);
        assert(data.ticket, "data.ticket is not defined:", JSON.stringify(data, null, 1));
        return data.ticket;
    };




    /**
     * Get the Zendesk tickets that are not closed and have the "GitLab Work Item" field set.
     * @returns
     */
    export async function getTickets(): Promise<any[]> {

        const query = `type:ticket status<closed custom_field_${gitlabWorkItemFieldId}:*`

        const { data, error } = await client.GET(`/api/v2/search`, {
            params: { query: { query } }
        });

        if (error || !data.results) {
            log("Error polling:", error);
            return []
        }

        if (!("results" in data)) return []
        if (data.results.length === 0) {
            log("No tickets found by query", query, JSON.stringify(data));
            return []
        }

        log("Tickets that are not closed that have a GitLab Work Item set:", data.results.map((t) => t.id));

        return data.results || data as TicketsResponse['results']
    }


    /** Current value of one of the ticket's custom fields, as a string. */
    export function getCustomFieldValue(
        ticket: NonNullable<zendesk.TicketsResponse['results']>[number],
        fieldId: number,
    ): string {
        const field = ticket.custom_fields.find((f) => f.id === fieldId);
        return field?.value == null ? "" : String(field.value);
    }

    /**
     * The GitLab work item a ticket points at.
     * @param ticket
     * @returns e.g. { ref: 'nuodb/server/nuodb#14509', ... }, or null when the
     *          field holds something that is not a GitLab work item reference.
     */
    export function getGitLabRef(
        ticket: NonNullable<zendesk.TicketsResponse['results']>[number],
    ): GitLabRef | null {
        return parseRef(getCustomFieldValue(ticket, zendesk.gitlabWorkItemFieldId), gitlabHost);
    }



    export async function deleteTicket(ticketId: number) {
        const { response, data, error } = await client.DELETE(`/api/v2/tickets/{ticket_id}`, {
            params: {
                path: { ticket_id: ticketId }
            }
        });
        if (error) {
            throw new Error(`Failed to delete ticket: ${error}`);
        }

    }

    /**
     * Only fields are written. The internal note is added by a Zendesk trigger
     * that fires on updates made by this service account, which is the only way
     * to have the note authored by System rather than by a person.
     */
    export interface ZendeskUpdateTicket {
        id: number,
        custom_fields: NonNullable<TicketsResponse['results']>[number]['custom_fields']
    }


    /** Zendesk rejects update_many requests carrying more than 100 tickets. */
    const UPDATE_MANY_LIMIT = 100;

    export async function updateTickets(ticketsToUpdate: ZendeskUpdateTicket[]) {

        for (let i = 0; i < ticketsToUpdate.length; i += UPDATE_MANY_LIMIT) {
            const body = {
                tickets: ticketsToUpdate.slice(i, i + UPDATE_MANY_LIMIT)
            };

            log("Updating GitLab props for zendesk tickets", body);
            const response = (await fetch(`/api/v2/tickets/update_many`, {
                method: "PUT",
                body: JSON.stringify(body)
            }));

            if (!response.ok) {
                log("Error updating tickets with status:", response.statusText);
            } else {
                log("Updated tickets:", body.tickets.map((t) => t.id));
            }
        }
    }
}


export default zendesk