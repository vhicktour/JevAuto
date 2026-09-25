export type Budget = { maxActions: number; maxMs: number; maxUsd: number }
export type Limit = 'actions' | 'time' | 'cost'

/** Spec §11: a default per run, extended only when you say so. */
export const DEFAULT_BUDGET: Budget = { maxActions: 40, maxMs: 6 * 60_000, maxUsd: 1 }
/** Full auto never asks to extend, so it starts larger and stops there. */
export const FULL_AUTO_BUDGET: Budget = { maxActions: 150, maxMs: 20 * 60_000, maxUsd: 3 }

/** Counts actions, active time and dollars. Time spent waiting for you (approvals, questions) is not counted. */
export class Meter {
  actions = 0
  usd = 0
  private limits: Budget
  private banked = 0
  private since?: number

  constructor(
    private readonly budget: Budget,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.limits = { ...budget }
  }

  start() {
    this.since ??= this.now()
  }
  pause() {
    if (this.since === undefined) return
    this.banked += this.now() - this.since
    this.since = undefined
  }
  resume() {
    this.start()
  }
  activeMs(): number {
    return this.banked + (this.since === undefined ? 0 : this.now() - this.since)
  }
  addAction() {
    this.actions += 1
  }
  addCost(usd: number) {
    this.usd += usd
  }
  over(): Limit | null {
    if (this.actions >= this.limits.maxActions) return 'actions'
    if (this.usd >= this.limits.maxUsd) return 'cost'
    if (this.activeMs() >= this.limits.maxMs) return 'time'
    return null
  }
  /** One more allowance of the same size as the original budget. */
  extend(limit: Limit) {
    if (limit === 'actions') this.limits.maxActions += this.budget.maxActions
    if (limit === 'cost') this.limits.maxUsd += this.budget.maxUsd
    if (limit === 'time') this.limits.maxMs += this.budget.maxMs
  }
}
