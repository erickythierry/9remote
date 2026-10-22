declare module "cross-spawn" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  function sync(command: string, args?: readonly string[], options?: SpawnOptions): any;
  export default spawn;
  export { spawn, sync };
}
