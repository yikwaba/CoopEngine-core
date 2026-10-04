import { Injectable } from '@nestjs/common';
/** Explicit clock boundary lets integration tests advance TOTP without changing JWT/DB time. */
@Injectable()
export class MfaClock { now(): number { return Math.floor(Date.now() / 1000); } }
