declare module "crypto-js" {
  const CryptoJS: {
    AES: { decrypt(cipher: string, secret: string): { toString(encoder: unknown): string } };
    enc: { Utf8: unknown };
  };
  export default CryptoJS;
}
