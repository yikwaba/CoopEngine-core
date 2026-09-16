import { IsOptional, Matches } from 'class-validator';

/**
 * Step-up verification code for actions that move money or rewrite the books.
 *
 * Optional at the edge: the cooperative's own setting decides whether it is demanded, and a
 * cooperative that has not asked for it must not be forced to send a code with every action.
 */
export class StepUpDto {
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'otp must be a six-digit code' })
  otp?: string;
}
