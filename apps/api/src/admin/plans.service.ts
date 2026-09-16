import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

export interface PlanView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceAmount: string;
  currency: string;
  billingPeriod: string;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  isActive: boolean;
  sortOrder: number;
  cooperatives?: number;
}

/** The platform's plan catalogue. Global configuration — no tenant scope involved. */
@Injectable()
export class PlansService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private readonly columns = `id, code, name, description, price_amount, currency, billing_period,
                              limits, features, is_active, sort_order`;

  private map(row: Record<string, unknown>): PlanView {
    return {
      id: row.id as string,
      code: row.code as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      priceAmount: String(row.price_amount),
      currency: row.currency as string,
      billingPeriod: row.billing_period as string,
      limits: (row.limits ?? {}) as Record<string, number | null>,
      features: (row.features ?? {}) as Record<string, boolean>,
      isActive: row.is_active as boolean,
      sortOrder: row.sort_order as number,
    };
  }

  /** How many cooperatives sit on each plan — the number that makes a catalogue useful. */
  async list(): Promise<PlanView[]> {
    const { rows } = await this.pool.query(
      `SELECT ${this.columns},
              (SELECT count(*)::int FROM subscriptions s
                WHERE s.plan_id = plans.id AND s.status <> 'CANCELLED') AS cooperatives
         FROM plans ORDER BY sort_order, code`,
    );
    return rows.map((row) => ({
      ...this.map(row as Record<string, unknown>),
      cooperatives: Number((row as { cooperatives: number }).cooperatives),
    }));
  }

  async create(dto: CreatePlanDto): Promise<PlanView> {
    const existing = await this.pool.query(`SELECT 1 FROM plans WHERE code = $1`, [
      dto.code.toUpperCase(),
    ]);
    if (existing.rowCount) {
      throw new ConflictException(`A plan with code ${dto.code.toUpperCase()} already exists`);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO plans (code, name, description, price_amount, limits, features, is_active, sort_order)
       VALUES ($1, $2, $3, coalesce($4::numeric, 0), $5::jsonb, $6::jsonb, coalesce($7, true), coalesce($8, 0))
       RETURNING ${this.columns}`,
      [
        dto.code.toUpperCase(),
        dto.name,
        dto.description ?? null,
        dto.priceAmount ?? null,
        JSON.stringify(dto.limits ?? {}),
        JSON.stringify(dto.features ?? {}),
        dto.isActive ?? null,
        dto.sortOrder ?? null,
      ],
    );
    return this.map(rows[0] as Record<string, unknown>);
  }

  async update(id: string, dto: UpdatePlanDto): Promise<PlanView> {
    const { rows } = await this.pool.query(
      `UPDATE plans
          SET name = coalesce($2, name),
              description = coalesce($3, description),
              price_amount = coalesce($4::numeric, price_amount),
              limits = coalesce($5::jsonb, limits),
              features = coalesce($6::jsonb, features),
              is_active = coalesce($7, is_active),
              sort_order = coalesce($8, sort_order),
              updated_at = now()
        WHERE id = $1
        RETURNING ${this.columns}`,
      [
        id,
        dto.name ?? null,
        dto.description ?? null,
        dto.priceAmount ?? null,
        dto.limits ? JSON.stringify(dto.limits) : null,
        dto.features ? JSON.stringify(dto.features) : null,
        dto.isActive ?? null,
        dto.sortOrder ?? null,
      ],
    );
    if (!rows[0]) throw new NotFoundException('Plan not found');
    return this.map(rows[0] as Record<string, unknown>);
  }
}
