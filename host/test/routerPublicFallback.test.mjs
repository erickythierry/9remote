// Self-hosted publicFallback: a non-loopback peer may load unclaimed static paths,
// never a private route — even one the predicate would accept.
// Run: node --test host/test/routerPublicFallback.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { networkInterfaces } from "node:os";
import { createRouter, jsonOk } from "../lib/router.js";

const lanIp = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const ROUTES = [
  { path: "/api/ui/state", method: "GET", handler: (req, res) => jsonOk(res, { permanentKey: "sk-secret" }) },
  { path: "/workspace/private", method: "GET", handler: (req, res) => jsonOk(res, { secret: true }) },
];
const fallback = (req, res) => { res.writeHead(200); res.end("static"); };
// Predicate deliberately over-broad: it must not open routes the table owns.
const publicFallback = (pathname) => !pathname.startsWith("/api/");

let server, port;
before(async () => {
  server = createServer(createRouter(ROUTES, { fallback, publicFallback }));
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
});
after(() => server.close());

const get = (path) => new Promise((resolve, reject) => {
  const req = request({ host: lanIp, port, path, localAddress: lanIp }, (res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

test("non-loopback peer loads an unclaimed static path", { skip: !lanIp && "no LAN interface" }, async () => {
  const res = await get("/login");
  assert.equal(res.status, 200);
  assert.equal(res.body, "static");
});

test("non-loopback peer cannot reach a private API route", { skip: !lanIp && "no LAN interface" }, async () => {
  const res = await get("/api/ui/state");
  assert.equal(res.status, 403);
  assert.ok(!res.body.includes("sk-secret"));
});

test("a route the table owns keeps its private flag even if the predicate says public", { skip: !lanIp && "no LAN interface" }, async () => {
  const res = await get("/workspace/private");
  assert.equal(res.status, 403);
});

test("without publicFallback, static paths stay loopback-only", { skip: !lanIp && "no LAN interface" }, async () => {
  const plain = createServer(createRouter(ROUTES, { fallback }));
  await new Promise((r) => plain.listen(0, "0.0.0.0", r));
  const p = plain.address().port;
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: lanIp, port: p, path: "/login", localAddress: lanIp }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  plain.close();
  assert.equal(status, 403);
});
