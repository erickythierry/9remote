// Tests the self-hosted VPN allowlist (CIDR match, IPv4-mapped, loopback).
// Run: node --test host/test/trustedNetwork.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildTrustedList, isTrustedVpnAddress, isAllowedPeer } = await import("../lib/trustedNetwork.js");

const list = buildTrustedList(["10.8.0.0/24", "fd00:8::/64"]);

test("peer inside the CIDR is trusted, plain and IPv4-mapped", () => {
  assert.equal(isTrustedVpnAddress("10.8.0.5", list), true);
  assert.equal(isTrustedVpnAddress("::ffff:10.8.0.5", list), true);
  assert.equal(isTrustedVpnAddress("fd00:8::2", list), true);
});

test("peer outside the CIDR is not trusted", () => {
  assert.equal(isTrustedVpnAddress("10.8.1.5", list), false);
  assert.equal(isTrustedVpnAddress("192.168.0.10", list), false);
  assert.equal(isTrustedVpnAddress("", list), false);
  assert.equal(isTrustedVpnAddress(undefined, list), false);
});

test("empty list trusts nobody but loopback", () => {
  const empty = buildTrustedList([]);
  assert.equal(isTrustedVpnAddress("10.8.0.5", empty), false);
  assert.equal(isAllowedPeer("127.0.0.1", empty), true);
  assert.equal(isAllowedPeer("::1", empty), true);
  assert.equal(isAllowedPeer("10.8.0.5", empty), false);
});

test("malformed entry throws", () => {
  assert.throws(() => buildTrustedList(["10.8.0/24"]));
  assert.throws(() => buildTrustedList(["10.8.0.0/x"]));
});
