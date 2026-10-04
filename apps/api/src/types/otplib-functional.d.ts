/** Minimal ambient types for the otplib v13 functional API. */
declare module 'otplib/functional' {
  export function generateSecret(options?: { length?: number }): string;
  export function generate(options: {
    secret: string;
    digits?: number;
    period?: number;
    epoch?: number;
  }): Promise<string>;
  export function generateSync(options: {
    secret: string;
    digits?: number;
    period?: number;
    epoch?: number;
  }): string;
  export function verify(options: {
    secret: string;
    token: string;
    afterTimeStep?: number;
    window?: number | [number, number];
    digits?: number;
    period?: number;
    epoch?: number;
  }): Promise<{ valid: true; timeStep: number } | { valid: false }>;
  export function verifySync(options: {
    secret: string;
    token: string;
    afterTimeStep?: number;
    window?: number | [number, number];
    digits?: number;
    period?: number;
    epoch?: number;
  }): { valid: boolean; delta?: number; epoch?: number };
  export function generateURI(options: {
    secret: string;
    label: string;
    issuer: string;
    digits?: number;
    period?: number;
    epoch?: number;
  }): string;
}
