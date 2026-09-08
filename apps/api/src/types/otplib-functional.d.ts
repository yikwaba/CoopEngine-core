/** Minimal ambient types for the otplib v13 functional API. */
declare module 'otplib/functional' {
  export function generateSecret(options?: { length?: number }): string;
  export function generate(options: {
    secret: string;
    digits?: number;
    period?: number;
  }): Promise<string>;
  export function generateSync(options: {
    secret: string;
    digits?: number;
    period?: number;
  }): string;
  export function verify(options: {
    secret: string;
    token: string;
    window?: number | [number, number];
    digits?: number;
    period?: number;
  }): Promise<{ valid: boolean; delta?: number; epoch?: number }>;
  export function verifySync(options: {
    secret: string;
    token: string;
    window?: number | [number, number];
    digits?: number;
    period?: number;
  }): { valid: boolean; delta?: number; epoch?: number };
  export function generateURI(options: {
    secret: string;
    label: string;
    issuer: string;
    digits?: number;
    period?: number;
  }): string;
}
