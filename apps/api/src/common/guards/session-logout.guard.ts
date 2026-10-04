import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/** A signed, unexpired predecessor can only end its own refresh family.
 * This does not grant access to any ordinary authenticated endpoint. */
@Injectable()
export class SessionLogoutGuard extends JwtAuthGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    return this.authenticateSession(context, true);
  }
}
