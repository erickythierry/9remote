declare module "archiver" {
  import type { Readable, Writable } from "stream";
  export interface Archiver extends Readable {
    on(event: "error", listener: (e: Error) => void): this;
    pipe<T extends Writable>(destination: T): T;
    directory(dirpath: string, destpath: string | false): this;
    finalize(): Promise<void>;
    destroy(error?: Error): this;
  }
  export default function archiver(format: "zip", options?: { zlib?: { level?: number } }): Archiver;
}
