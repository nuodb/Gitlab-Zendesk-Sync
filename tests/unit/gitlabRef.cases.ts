/**
 * Shared fixture table for the GitLab reference parser.
 *
 * Plain data, no imports, so it can be consumed by any runner.
 * `expected` is the canonical ref string, or null when the value must be rejected.
 */

export interface ParseCase {
    name: string;
    input: unknown;
    /** Passed as parseRef's host argument when present. */
    host?: string;
    expected: string | null;
}

const HOST = "gitlab.example.com";
const BASE = `https://${HOST}`;

export const cases: ParseCase[] = [
    // --- URLs an agent would paste from the browser ---
    {
        name: "canonical work item URL",
        input: `${BASE}/platform/backend/-/work_items/123`,
        expected: "platform/backend#123",
    },
    {
        name: "legacy /-/issues/ URL resolves to the same ref as /-/work_items/",
        input: `${BASE}/platform/backend/-/issues/123`,
        expected: "platform/backend#123",
    },
    {
        name: "nested subgroups keep their full path",
        input: `${BASE}/platform/team/backend/-/issues/9`,
        expected: "platform/team/backend#9",
    },
    {
        name: "merge request URL",
        input: `${BASE}/platform/backend/-/merge_requests/45`,
        expected: "platform/backend!45",
    },
    {
        name: "group level epic drops the /groups/ prefix",
        input: `${BASE}/groups/platform/-/epics/7`,
        expected: "platform&7",
    },
    {
        name: "http is accepted as well as https",
        input: `http://${HOST}/platform/backend/-/issues/123`,
        expected: "platform/backend#123",
    },

    // --- Real-world messiness ---
    {
        name: "comment anchor is discarded",
        input: `${BASE}/platform/backend/-/issues/123#note_98765`,
        expected: "platform/backend#123",
    },
    {
        name: "query string is discarded",
        input: `${BASE}/platform/backend/-/issues/123?work_item_iid=5`,
        expected: "platform/backend#123",
    },
    {
        name: "trailing slash is tolerated",
        input: `${BASE}/platform/backend/-/issues/123/`,
        expected: "platform/backend#123",
    },
    {
        name: "deep link to a sub page still resolves to the parent item",
        input: `${BASE}/platform/backend/-/issues/123/designs`,
        expected: "platform/backend#123",
    },
    {
        name: "surrounding whitespace is trimmed",
        input: `  ${BASE}/platform/backend/-/issues/123  `,
        expected: "platform/backend#123",
    },

    // --- Hand-typed GitLab reference syntax ---
    {
        name: "short form issue reference",
        input: "platform/backend#123",
        expected: "platform/backend#123",
    },
    {
        name: "short form merge request reference",
        input: "platform/backend!45",
        expected: "platform/backend!45",
    },
    {
        name: "short form epic reference",
        input: "platform&7",
        expected: null, // no namespace separator: not addressable
    },

    // --- Host enforcement ---
    {
        name: "matching host is accepted when host is enforced",
        input: `${BASE}/platform/backend/-/issues/123`,
        host: HOST,
        expected: "platform/backend#123",
    },
    {
        name: "foreign host is rejected when host is enforced",
        input: "https://gitlab.com/someone/else/-/issues/1",
        host: HOST,
        expected: null,
    },
    {
        name: "host comparison is case insensitive",
        input: `https://GitLab.Example.COM/platform/backend/-/issues/123`,
        host: HOST,
        expected: "platform/backend#123",
    },

    // --- The real instance: bare internal hostname, no TLD ---
    {
        name: "nuohub issue URL",
        input: "https://nuohub/platform/backend/-/issues/123",
        host: "nuohub",
        expected: "platform/backend#123",
    },
    {
        name: "nuohub work item URL",
        input: "https://nuohub/platform/backend/-/work_items/123",
        host: "nuohub",
        expected: "platform/backend#123",
    },
    {
        name: "nuohub merge request URL",
        input: "https://nuohub/platform/backend/-/merge_requests/45",
        host: "nuohub",
        expected: "platform/backend!45",
    },
    {
        name: "nuohub subgroup URL",
        input: "https://nuohub/platform/team/backend/-/issues/9",
        host: "nuohub",
        expected: "platform/team/backend#9",
    },
    {
        name: "nuohub URL with trailing slash on the host root is not an item",
        input: "https://nuohub/",
        host: "nuohub",
        expected: null,
    },

    // --- Real values seen in the Zendesk field ---
    {
        name: "fully qualified host matches the short configured host",
        input: "https://nuohub.dsone.3ds.com/nuodb/server/nuodb/-/work_items/14629",
        host: "nuohub",
        expected: "nuodb/server/nuodb#14629",
    },
    {
        name: "short host matches a fully qualified configured host",
        input: "https://nuohub/nuodb/server/nuodb/-/work_items/14629",
        host: "nuohub.dsone.3ds.com",
        expected: "nuodb/server/nuodb#14629",
    },
    {
        name: "link embedded in free text alongside an old tracker key",
        input: "DB-42624 and https://nuohub/nuodb/server/nuodb/-/work_items/14293",
        host: "nuohub",
        expected: "nuodb/server/nuodb#14293",
    },
    {
        name: "group level epic link",
        input: "https://nuohub/groups/nuodb/server/-/epics/17",
        host: "nuohub",
        expected: "nuodb/server&17",
    },
    {
        name: "an unrelated host is still rejected when embedded in text",
        input: "see https://gitlab.com/someone/else/-/issues/1 for details",
        host: "nuohub",
        expected: null,
    },

    // --- Values that must be rejected ---
    { name: "empty string", input: "", expected: null },
    { name: "whitespace only", input: "   ", expected: null },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
    { name: "number", input: 123, expected: null },
    {
        name: "issue key from another tracker",
        input: "DB-40467",
        expected: null,
    },
    {
        name: "URL from another tracker",
        input: "http://othertracker.example.com/browse/DB-40467",
        expected: null,
    },
    {
        name: "project URL with no work item",
        input: `${BASE}/platform/backend`,
        expected: null,
    },
    {
        name: "non numeric iid",
        input: `${BASE}/platform/backend/-/issues/abc`,
        expected: null,
    },
    {
        name: "iid of zero",
        input: `${BASE}/platform/backend/-/issues/0`,
        expected: null,
    },
    {
        name: "unsupported GitLab route",
        input: `${BASE}/platform/backend/-/pipelines/44`,
        expected: null,
    },
    {
        name: "free text",
        input: "will fix next sprint",
        expected: null,
    },
];
