import { test, expect, describe } from "bun:test";
import { parseRef, groupByPath } from "../../gitlabRef";
import { cases } from "./gitlabRef.cases";

// Offline unit tests: no network, no credentials, no running sync server.
// Run just these with:  bun test tests/unit

describe("parseRef", () => {
    for (const c of cases) {
        test(c.name, () => {
            const got = parseRef(c.input, c.host);
            expect(got === null ? null : got.ref).toBe(c.expected);
        });
    }

    test("exposes the parts needed to fetch the item", () => {
        const ref = parseRef("https://gitlab.example.com/platform/team/backend/-/merge_requests/45");
        expect(ref).toEqual({
            fullPath: "platform/team/backend",
            kind: "merge_request",
            iid: 45,
            ref: "platform/team/backend!45",
        });
    });
});

describe("groupByPath", () => {
    test("batches refs by namespace so each project needs one query alias", () => {
        const refs = ["platform/backend#1", "platform/backend#2", "platform/frontend#9"]
            .map((s) => parseRef(s)!)

        const grouped = groupByPath(refs);

        expect(grouped.size).toBe(2);
        expect(grouped.get("platform/backend")!.map((r) => r.iid)).toEqual([1, 2]);
        expect(grouped.get("platform/frontend")!.map((r) => r.iid)).toEqual([9]);
    });

    test("returns an empty map for no refs", () => {
        expect(groupByPath([]).size).toBe(0);
    });
});
