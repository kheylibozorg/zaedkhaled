import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allOrderErrors, filledMetaOf, parseOrderId, protectionLanded } from "./hyperliquid.ts";

describe("Hyperliquid response & protection parsers", () => {
  it("parses resting/filled order ids and errors cleanly", () => {
    const resting = { status: "ok", response: { data: { statuses: [{ resting: { oid: 98765 } }] } } };
    assert.equal(parseOrderId(resting), "98765");
    assert.equal(allOrderErrors(resting), null);

    const filled = {
      status: "ok",
      response: { data: { statuses: [{ filled: { oid: 12345, avgPx: "64123.5", totalSz: "0.02" } }] } },
    };
    assert.equal(parseOrderId(filled), "12345");
    assert.deepEqual(filledMetaOf(filled), { fillPrice: 64123.5, filledQty: 0.02 });

    const errored = {
      status: "ok",
      response: { data: { statuses: [{ filled: { oid: 11 } }, { error: "Trigger price invalid" }] } },
    };
    assert.equal(allOrderErrors(errored), "Trigger price invalid");
    assert.equal(protectionLanded(errored, 2), false);
    assert.equal(protectionLanded(errored, 1), false);
  });

  it("confirms protectionLanded only when required legs succeed error-free", () => {
    const ok2 = {
      status: "ok",
      response: { data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }] } },
    };
    assert.equal(protectionLanded(ok2, 2), true);
    assert.equal(protectionLanded(ok2, 3), false);
  });
});
