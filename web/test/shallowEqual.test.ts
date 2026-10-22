import assert from "node:assert/strict";
import { sameEntry, sameList, sameMap } from "../shared/utils/shallowEqual.js";

assert.equal(sameEntry({ id: 1, name: "a" }, { id: 1, name: "a" }), true);
assert.equal(sameEntry({ a: undefined }, { b: undefined }), false);
assert.equal(sameEntry({ id: 1 }, { id: "1" }), false);
assert.equal(sameList([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }]), true);
assert.equal(sameList([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]), false);
assert.equal(sameMap({ session: { unread: 2 } }, { session: { unread: 2 } }), true);
assert.equal(sameMap({ session: { unread: 2 } }, { session: { unread: 3 } }), false);
