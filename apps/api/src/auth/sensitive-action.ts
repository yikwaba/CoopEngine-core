import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { AuthPrincipal } from '../common/auth.types';
export const SENSITIVE_ACTION = 'coopengine:sensitive-action';
export const SensitiveAction = (action: string) => SetMetadata(SENSITIVE_ACTION, action);
/** Interceptors run after authentication and permission guards, before controller work. */
@Injectable()
export class SensitiveActionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const action = this.reflector.get<string>(SENSITIVE_ACTION, context.getHandler());
    if (action) {
      const req = context.switchToHttp().getRequest<{ user: AuthPrincipal; headers: Record<string,string | string[] | undefined>; body?: {otp?: unknown} }>();
      const header = req.headers['x-coopengine-step-up'];
      const code = typeof header === 'string' ? header : typeof req.body?.otp === 'string' ? req.body.otp : undefined;
      await this.auth.assertStepUp(req.user.organizationId,req.user.userId,code,action,req.user.sessionId);
    }
    return next.handle();
  }
}
