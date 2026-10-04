import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthPrincipal } from '../auth.types';

/** Enforces @RequirePermissions against the principal's JWT permission set. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    // A guarded endpoint without a policy is a configuration error, never an
    // implicit grant. Public and session-only endpoints do not use this guard.
    if (!required || required.length === 0) {
      throw new ForbiddenException('Permission policy is not configured');
    }

    const request = context.switchToHttp().getRequest();
    const principal = request.user as AuthPrincipal | undefined;
    const owned = principal?.permissions ?? [];
    if (required.some((permission) => owned.includes(permission))) return true;

    throw new ForbiddenException(
      `Missing required permission(s): ${required.join(', ')}`,
    );
  }
}
