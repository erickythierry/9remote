// crypto.hash is Node 21.7+; @types/node 18 lacks it. Module file so this augments node:crypto.
export {};
declare module "node:crypto" {
  function hash(algorithm: string, data: Uint8Array): string;
}
