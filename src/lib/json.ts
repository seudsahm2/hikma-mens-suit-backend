/** Express can't serialise BigInt (telegramId); convert to string globally. */
export function installBigIntJson() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function toJSON() {
    return this.toString();
  };
}
