import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGGREGATE_GAUGE_SQL, AGGREGATE_SQL, SCHEMA_SQL } from "@/lib/sql/statements";

/** The .sql mirrors must stay byte-identical to the embedded canonical strings. */
describe("SQL drift guard", () => {
  it("schema.sql matches SCHEMA_SQL", () => {
    const path = fileURLToPath(new URL("../src/lib/sql/schema.sql", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(SCHEMA_SQL);
  });

  it("aggregate.sql matches AGGREGATE_SQL", () => {
    const path = fileURLToPath(new URL("../src/lib/sql/aggregate.sql", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(AGGREGATE_SQL);
  });

  it("aggregate-gauge.sql matches AGGREGATE_GAUGE_SQL", () => {
    const path = fileURLToPath(new URL("../src/lib/sql/aggregate-gauge.sql", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(AGGREGATE_GAUGE_SQL);
  });

  it("both aggregations order by the total order (event_time_ms, event_id)", () => {
    // The single most important guarantee: a TOTAL order inside the window fn.
    expect(AGGREGATE_SQL).toContain("ORDER BY event_time_ms, event_id");
    expect(AGGREGATE_GAUGE_SQL).toContain("ORDER BY event_time_ms DESC, event_id DESC");
  });
});
