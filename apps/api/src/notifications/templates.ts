import { randomUUID } from 'node:crypto';

/** Notification types that a cooperative may word itself. */
export const TEMPLATE_CODES = [
  'CONTRIBUTION_DUE',
  'REPAYMENT_RECEIVED',
  'LOAN_APPROVED',
  'LOAN_DISBURSED',
  'DIVIDEND_PAID',
  'SAVINGS_GOAL_ACHIEVED',
] as const;

export type TemplateCode = (typeof TEMPLATE_CODES)[number];

export interface TemplateDefinition {
  code: TemplateCode;
  /** What the message is for, in plain language, shown in the portal. */
  description: string;
  /** Best channel: SMS messages must stay short. */
  channel: 'SMS' | 'EMAIL' | 'ANY';
  title: string;
  body: string;
  /** Placeholders this template can use, with a sample value for previews. */
  variables: Record<string, string>;
}

/**
 * Built-in wording. Used when a cooperative has not written its own template,
 * so nothing depends on a template existing — and `reset` returns to this.
 */
export const DEFAULT_TEMPLATES: Record<TemplateCode, TemplateDefinition> = {
  CONTRIBUTION_DUE: {
    code: 'CONTRIBUTION_DUE',
    description: 'Reminder before a standing contribution falls due',
    channel: 'SMS',
    title: 'Contribution due',
    body: 'Hi {{memberName}}, your {{frequency}} contribution of N{{amount}} is due. Pay into your collection account to keep your savings on track.',
    variables: {
      memberName: 'Ada Okafor',
      frequency: 'MONTHLY',
      amount: '5,000.00',
      dueDate: '2026-10-01',
      organizationName: 'Sunrise Cooperative',
    },
  },
  REPAYMENT_RECEIVED: {
    code: 'REPAYMENT_RECEIVED',
    description: 'Confirmation that a loan repayment was recorded',
    channel: 'SMS',
    title: 'Repayment received',
    body: 'Hi {{memberName}}, we received your repayment of N{{amount}}. Outstanding balance: N{{outstanding}}. Thank you.',
    variables: {
      memberName: 'Ada Okafor',
      amount: '13,833.33',
      outstanding: '26,666.67',
      organizationName: 'Sunrise Cooperative',
    },
  },
  LOAN_APPROVED: {
    code: 'LOAN_APPROVED',
    description: 'Tells a member their loan application was approved',
    channel: 'SMS',
    title: 'Loan approved',
    body: 'Hi {{memberName}}, your loan of N{{amount}} has been approved. You will be notified when it is disbursed.',
    variables: {
      memberName: 'Ada Okafor',
      amount: '40,000.00',
      organizationName: 'Sunrise Cooperative',
    },
  },
  LOAN_DISBURSED: {
    code: 'LOAN_DISBURSED',
    description: 'Tells a member the money has been paid out',
    channel: 'SMS',
    title: 'Loan disbursed',
    body: 'Hi {{memberName}}, your loan of N{{amount}} has been disbursed. First repayment is due on {{dueDate}}.',
    variables: {
      memberName: 'Ada Okafor',
      amount: '40,000.00',
      dueDate: '2026-10-01',
      organizationName: 'Sunrise Cooperative',
    },
  },
  DIVIDEND_PAID: {
    code: 'DIVIDEND_PAID',
    description: 'Notice that a dividend was credited to savings',
    channel: 'SMS',
    title: 'Dividend credited ({{period}})',
    body: 'Hi {{memberName}}, your {{period}} dividend of N{{amount}} has been credited to your savings. Thank you for saving with us.',
    variables: {
      memberName: 'Ada Okafor',
      period: '2026-Q3',
      amount: '8,500.00',
      organizationName: 'Sunrise Cooperative',
    },
  },
  SAVINGS_GOAL_ACHIEVED: {
    code: 'SAVINGS_GOAL_ACHIEVED',
    description: 'Celebrates a member reaching a savings goal',
    channel: 'SMS',
    title: 'Goal reached: {{goalName}}',
    body: 'Congratulations {{memberName}}! You have saved N{{progress}} towards your N{{target}} target for {{goalName}}. Well done!',
    variables: {
      memberName: 'Ada Okafor',
      goalName: 'School fees 2027',
      progress: '120,000.00',
      target: '120,000.00',
      organizationName: 'Sunrise Cooperative',
    },
  },
};

export const TEMPLATE_CODE_SET = new Set<string>(TEMPLATE_CODES);

export interface RenderedTemplate {
  title: string;
  body: string;
  /** Placeholders present in the template that had no value supplied. */
  unresolved: string[];
}

/**
 * Replace {{placeholder}} tokens with values. Unknown placeholders are left
 * visible on purpose: a cooperative previewing its wording should see what it
 * still has to fill in, rather than a silently blank message.
 */
export function renderTemplate(text: string, vars: Record<string, unknown>): RenderedTemplate {
  const unresolved = new Set<string>();
  const out = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null || value === '') {
      unresolved.add(key);
      return `{{${key}}}`;
    }
    return String(value);
  });
  return { title: out, body: out, unresolved: [...unresolved] };
}

/** Render both parts of a message, reporting placeholders that had no value. */
export function renderMessage(
  title: string,
  body: string,
  vars: Record<string, unknown>,
): RenderedTemplate {
  const rt = renderTemplate(title, vars);
  const rb = renderTemplate(body, vars);
  return {
    title: rt.title,
    body: rb.body,
    unresolved: [...new Set([...rt.unresolved, ...rb.unresolved])],
  };
}

export interface TemplateRow {
  code: string;
  channel: string;
  title: string;
  body: string;
  isActive: boolean;
  updatedAt?: string;
}

/** Human-readable summary used by the preview endpoint. */
export function previewTemplate(
  template: { title: string; body: string; variables?: Record<string, string> },
  overrides?: Record<string, unknown>,
): RenderedTemplate & { sampleVars: Record<string, string> } {
  const sampleVars = { ...(template.variables ?? {}), ...(overrides ?? {}) } as Record<string, string>;
  const rendered = renderMessage(template.title, template.body, sampleVars);
  return { ...rendered, sampleVars };
}

export const newTemplateId = (): string => randomUUID();
