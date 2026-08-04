/**
 * The engine never throws for *rule* problems — an illegal action is an
 * expected outcome, not an exception. `Err` values cross the wire to the
 * client so the UI can explain why a move was rejected. Throwing is reserved
 * for engine bugs (corrupt state, missing card definition).
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Why an action was rejected. `code` is stable; `message` is for humans. */
export interface RuleViolation {
  readonly code: RuleViolationCode;
  readonly message: string;
  /** Rules.md section this rule comes from, when there is one. */
  readonly rule?: string;
}

export type RuleViolationCode =
  | 'NOT_YOUR_TURN'
  | 'NOT_YOUR_PRIORITY'
  | 'WRONG_PHASE'
  | 'UNKNOWN_CARD'
  | 'CARD_NOT_IN_ZONE'
  | 'ILLEGAL_TARGET'
  | 'INSUFFICIENT_RESOURCES'
  | 'ALREADY_ACTED'
  | 'GAME_OVER'
  | 'NOT_IMPLEMENTED';

export const violation = (
  code: RuleViolationCode,
  message: string,
  rule?: string,
): Err<RuleViolation> => err(rule === undefined ? { code, message } : { code, message, rule });
