declare module "qrcode-terminal" {
  export function generate(input: string, options?: { small?: boolean }, callback?: (qrcode: string) => void): void;
  export function setErrorLevel(errorLevel: string): void;
}
