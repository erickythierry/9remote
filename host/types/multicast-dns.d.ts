declare module "multicast-dns" {
  export type MdnsRecord = { name: string; type: string; data: string };
  export type MdnsResponse = { answers?: MdnsRecord[]; additionals?: MdnsRecord[] };
  type MdnsQuestion = { name: string; type: "A" };
  export type MdnsClient = {
    on(event: "error", listener: () => void): MdnsClient;
    on(event: "response", listener: (response: MdnsResponse) => void): MdnsClient;
    query(message: { questions: MdnsQuestion[] }): void;
    destroy(): void;
  };
  function makeMdns(options: { reuseAddr: boolean }): MdnsClient;
  export default makeMdns;
}
