// Node 22.5+ built-in missing from @types/node 18; members used across host features.
declare module "node:sqlite" {
  export interface StatementSync {
    all<T = any>(...params: any[]): T[];
    get<T = any>(...params: any[]): T | undefined;
    run(...params: any[]): any;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
