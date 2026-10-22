declare module "cross-spawn/lib/parse.js" {
  type ParseOptions = { env?: NodeJS.ProcessEnv; cwd?: string; [key: string]: unknown };
  type ParsedCommand = {
    command: string;
    args: string[];
    options: ParseOptions & { windowsVerbatimArguments?: boolean };
  };
  function parse(command: string, args?: string[], options?: ParseOptions): ParsedCommand;
  export default parse;
}
