// ─── Finora — Financial Intelligence Engine ────────────────────
//
// Pure, deterministic analysis over the logged-in user's REAL transaction
// history (read server-side by the Financial Context Builder). No AI, no
// random values, no fabricated numbers: every output is derived directly
// from recorded transactions, budgets, debts, goals and (optionally) the
// latest financial assessment.
//
// CORE RULE (mirrors builder.ts): when the recorded data is insufficient for
// a capability, that capability is returned as `available: false` with the
// reason. Missing data is NEVER treated as zero and never guessed.
//
// The AI's job is only to interpret and explain these results — never to
// recompute or extend them.

import { calculateAllMetrics } from "./financialCalculations.ts";
import { calculateGoalMetrics } from "./goalCalculations.ts";
import type { AssessmentInput, AssessmentMetrics } from "./financialCalculations.ts";

// Categories the app treats as needs. "Cicilan" is debt-related and handled
// through the debts source, not day-to-day discretionary spending.
export const ESSENTIAL_CATEGORIES = new Set([
  "Makanan",
  "Tagihan",
  "Transportasi",
  "Kesehatan",
  "Pendidikan",
  "Komunikasi",
]);

const DEBT_CATEGORY = "Cicilan";

export interface IntelligenceTxRow {
  type: string; // 'income' | 'expense'
  category: string;
  amount: number;
  transaction_date: string; // 'YYYY-MM-DD'
}

export interface IntelligenceBudgetItem {
  category: string;
  limitAmount: number;
  spent: number; // current-month actuals (computed by the builder)
  percentage: number;
}

export interface IntelligenceGoalItem {
  name: string;
  targetAmount: number;
  currentSavings: number;
  deadline: string;
  isAchieved: boolean;
  requiredMonthlyContribution: number | null; // null when overdue
}

export interface IntelligenceInput {
  transactions: IntelligenceTxRow[];
  budgets: IntelligenceBudgetItem[];
  goals: IntelligenceGoalItem[];
  /** Latest assessment metrics, when the user has completed one. */
  assessment: {
    input: AssessmentInput;
    metrics: AssessmentMetrics;
    capturedAt: string;
  } | null;
  now: Date;
}

export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function rp(value: number): string {
  return `Rp ${Math.round(value).toLocaleString("id-ID")}`;
}

function pctRound(n: number): number {
  return Math.max(0, Math.round(n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Month aggregation ─────────────────────────────────────────

export interface MonthlyTotals {
  monthKey: string;
  income: number;
  expenses: number;
  cashFlow: number;
  transactionCount: number;
  isCurrentMonth: boolean;
}

export interface IncomeExpenseAnalysis {
  available: boolean;
  reason?: string;
  completedMonthsAnalyzed: number;
  avgMonthlyIncome: number | null;
  avgMonthlyExpenses: number | null;
  avgMonthlyCashFlow: number | null;
  /** Average of completed months only — the current partial month is excluded. */
  incomeTrend: "up" | "down" | "stable" | null;
  expenseTrend: "up" | "down" | "stable" | null;
}

export interface CategoryAnalysisItem {
  category: string;
  total: number;
  monthlyAverage: number;
  shareOfExpenses: number; // percent of total expenses, 0-100
  isEssential: boolean;
  isDebtRelated: boolean;
  lastCompletedMonthTotal: number | null;
  previousCompletedMonthTotal: number | null;
  changePct: number | null; // MoM change in percent, null when not computable
}

export interface OverspendingAlert {
  kind: "budget_exceeded" | "budget_near_limit" | "category_spike";
  category: string;
  severity: "warning" | "critical";
  detail: string;
}

export interface SavingCapacityAnalysis {
  available: boolean;
  reason?: string;
  avgMonthlySurplus: number | null;
  savingsRatePct: number | null; // surplus / income, 0-100+
  positiveCashFlowMonths: number | null;
  completedMonthsAnalyzed: number;
}

export interface GoalFeasibilityItem {
  name: string;
  requiredMonthlyContribution: number | null;
  feasibleWithCurrentSurplus: boolean | null; // null when capacity unknown
  monthsToFundAtCurrentCapacity: number | null;
  note: string;
}

export interface ForecastResult {
  available: boolean;
  reason?: string;
  confidence: "low" | "medium" | null;
  method: string | null;
  projectedIncome: number | null;
  projectedExpenses: number | null;
  projectedCashFlow: number | null;
}

export interface HealthScore {
  available: boolean;
  reason?: string;
  score: number | null; // 0-100
  status: "good" | "warning" | "critical" | null;
  components: { label: string; earned: number; max: number; note: string }[];
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  basis: string; // the computed numbers this recommendation rests on
  priority: number; // 1 = highest
}

export interface FinancialIntelligence {
  available: boolean;
  dataWindowMonths: number;
  months: MonthlyTotals[];
  completedMonthsAnalyzed: number;
  incomeExpense: IncomeExpenseAnalysis;
  categories: {
    available: boolean;
    reason?: string;
    totalExpenses: number;
    items: CategoryAnalysisItem[];
  };
  overspending: {
    available: boolean;
    alerts: OverspendingAlert[];
  };
  savingCapacity: SavingCapacityAnalysis;
  goalFeasibility: {
    available: boolean;
    reason?: string;
    items: GoalFeasibilityItem[];
  };
  forecast: ForecastResult;
  health: HealthScore;
  recommendations: {
    available: boolean;
    reason?: string;
    items: Recommendation[];
  };
}

// ─── Engine ────────────────────────────────────────────────────

function trendOf(values: number[]): "up" | "down" | "stable" | null {
  // Compare the mean of the last half against the mean of the first half.
  if (values.length < 2) return null;
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, values.length - half);
  const last = values.slice(values.length - half);
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const a = avg(first);
  const b = avg(last);
  if (a <= 0) return null;
  const change = (b - a) / a;
  if (change > 0.1) return "up";
  if (change < -0.1) return "down";
  return "stable";
}

export function buildFinancialIntelligence(input: IntelligenceInput): FinancialIntelligence {
  const { now } = input;
  const WINDOW_MONTHS = 6;
  const currentKey = monthKeyOf(now);
  const windowStart = addMonths(now, -(WINDOW_MONTHS - 1)); // first day of that month

  // Aggregate recorded transactions per calendar month inside the window.
  const monthMap = new Map<string, MonthlyTotals>();
  for (let i = 0; i < WINDOW_MONTHS; i++) {
    const key = monthKeyOf(addMonths(windowStart, i));
    monthMap.set(key, {
      monthKey: key,
      income: 0,
      expenses: 0,
      cashFlow: 0,
      transactionCount: 0,
      isCurrentMonth: key === currentKey,
    });
  }

  const categoryTotals = new Map<string, number>();
  const categoryByMonth = new Map<string, Map<string, number>>(); // monthKey -> category -> total

  let windowExpenseTotal = 0;
  let windowIncomeTotal = 0;
  let transactionsInWindow = 0;

  for (const tx of input.transactions) {
    const amount = Number(tx.amount);
    const date = new Date(`${tx.transaction_date}T00:00:00`);
    const key = monthKeyOf(date);
    const bucket = monthMap.get(key);
    if (!bucket) continue; // outside the 6-month analysis window
    transactionsInWindow++;
    if (tx.type === "income") {
      bucket.income += amount;
      windowIncomeTotal += amount;
    } else {
      bucket.expenses += amount;
      bucket.cashFlow = bucket.income - bucket.expenses;
      windowExpenseTotal += amount;
      categoryTotals.set(tx.category, (categoryTotals.get(tx.category) ?? 0) + amount);
      let byCat = categoryByMonth.get(key);
      if (!byCat) {
        byCat = new Map<string, number>();
        categoryByMonth.set(key, byCat);
      }
      byCat.set(tx.category, (byCat.get(tx.category) ?? 0) + amount);
    }
    bucket.transactionCount++;
  }

  const months = Array.from(monthMap.values()).sort((a, b) =>
    a.monthKey.localeCompare(b.monthKey)
  );
  for (const m of months) m.cashFlow = m.income - m.expenses;

  // Completed months: every month in the window before the current one.
  const completed = months.filter((m) => !m.isCurrentMonth);
  const completedWithTx = completed.filter((m) => m.transactionCount > 0);
  const completedMonthsAnalyzed = completedWithTx.length;

  // ─── 1. Income & expense analysis ────────────────────────────
  const incomeExpense: IncomeExpenseAnalysis = (() => {
    if (completedMonthsAnalyzed === 0) {
      return {
        available: false,
        reason:
          "Belum ada bulan lengkap dengan transaksi tercatat. Butuh minimal 1 bulan penuh (bulan sebelum bulan berjalan).",
        completedMonthsAnalyzed: 0,
        avgMonthlyIncome: null,
        avgMonthlyExpenses: null,
        avgMonthlyCashFlow: null,
        incomeTrend: null,
        expenseTrend: null,
      };
    }
    const n = completedMonthsAnalyzed;
    const avgIncome = windowIncomeTotal > 0 || completedWithTx.some((m) => m.income > 0)
      ? completedWithTx.reduce((s, m) => s + m.income, 0) / n
      : 0;
    const avgExpenses = completedWithTx.reduce((s, m) => s + m.expenses, 0) / n;
    const avgCashFlow = completedWithTx.reduce((s, m) => s + m.cashFlow, 0) / n;
    return {
      available: true,
      completedMonthsAnalyzed: n,
      avgMonthlyIncome: Math.round(avgIncome),
      avgMonthlyExpenses: Math.round(avgExpenses),
      avgMonthlyCashFlow: Math.round(avgCashFlow),
      incomeTrend: trendOf(completedWithTx.map((m) => m.income)),
      expenseTrend: trendOf(completedWithTx.map((m) => m.expenses)),
    };
  })();

  // ─── 2. Expense category analysis ────────────────────────────
  const categories = (() => {
    if (windowExpenseTotal <= 0) {
      return {
        available: false,
        reason: "Belum ada transaksi pengeluaran tercatat dalam periode analisis.",
        totalExpenses: 0,
        items: [] as CategoryAnalysisItem[],
      };
    }
    const lastCompleted = completedWithTx[completedWithTx.length - 1];
    const prevCompleted = completedWithTx[completedWithTx.length - 2];
    const items: CategoryAnalysisItem[] = Array.from(categoryTotals.entries())
      .map(([category, total]) => {
        const lastTotal = lastCompleted
          ? (categoryByMonth.get(lastCompleted.monthKey)?.get(category) ?? 0)
          : null;
        const prevTotal = prevCompleted
          ? (categoryByMonth.get(prevCompleted.monthKey)?.get(category) ?? 0)
          : null;
        const changePct =
          lastTotal !== null && prevTotal !== null && prevTotal > 0
            ? Math.round(((lastTotal - prevTotal) / prevTotal) * 100)
            : null;
        return {
          category,
          total: Math.round(total),
          monthlyAverage: Math.round(total / WINDOW_MONTHS),
          shareOfExpenses: pctRound((total / windowExpenseTotal) * 100),
          isEssential: ESSENTIAL_CATEGORIES.has(category),
          isDebtRelated: category === DEBT_CATEGORY,
          lastCompletedMonthTotal: lastTotal,
          previousCompletedMonthTotal: prevTotal,
          changePct,
        };
      })
      .sort((a, b) => b.total - a.total);
    return { available: true, totalExpenses: Math.round(windowExpenseTotal), items };
  })();

  // ─── 3. Overspending detection ───────────────────────────────
  const overspendingAlerts: OverspendingAlert[] = [];
  for (const b of input.budgets) {
    if (b.limitAmount > 0 && b.spent > b.limitAmount) {
      overspendingAlerts.push({
        kind: "budget_exceeded",
        category: b.category,
        severity: "critical",
        detail: `Anggaran ${b.category} terlampaui: terpakai ${rp(b.spent)} dari batas ${rp(b.limitAmount)} (${b.percentage}%).`,
      });
    } else if (b.limitAmount > 0 && b.percentage >= 80) {
      overspendingAlerts.push({
        kind: "budget_near_limit",
        category: b.category,
        severity: "warning",
        detail: `Anggaran ${b.category} hampir habis: ${b.percentage}% terpakai (${rp(b.spent)} dari ${rp(b.limitAmount)}).`,
      });
    }
  }
  const lastCompleted = months.filter((m) => !m.isCurrentMonth && m.transactionCount > 0).at(-1);
  const prevCompleted = months.filter((m) => !m.isCurrentMonth && m.transactionCount > 0).at(-2);
  if (lastCompleted && prevCompleted) {
    const lastCats = categoryByMonth.get(lastCompleted.monthKey);
    const prevCats = categoryByMonth.get(prevCompleted.monthKey);
    if (lastCats && prevCats) {
      for (const [category, lastTotal] of lastCats) {
        const prevTotal = prevCats.get(category) ?? 0;
        if (prevTotal > 0 && lastTotal > prevTotal * 1.3 && lastTotal - prevTotal >= 50_000) {
          overspendingAlerts.push({
            kind: "category_spike",
            category,
            severity: "warning",
            detail: `Pengeluaran ${category} naik ${pctRound(((lastTotal - prevTotal) / prevTotal) * 100)}% dibanding bulan sebelumnya (${rp(prevTotal)} → ${rp(lastTotal)}).`,
          });
        }
      }
    }
  }
  const overspending = {
    available: input.budgets.length > 0 || completedMonthsAnalyzed >= 2,
    alerts: overspendingAlerts.sort((a, b) =>
      a.kind === "budget_exceeded" ? -1 : b.kind === "budget_exceeded" ? 1 : 0
    ),
  };

  // ─── 4. Saving capacity analysis ─────────────────────────────
  const savingCapacity: SavingCapacityAnalysis = (() => {
    if (completedMonthsAnalyzed === 0) {
      return {
        available: false,
        reason:
          "Tidak dapat menghitung kapasitas menabung: belum ada bulan lengkap dengan transaksi tercatat.",
        avgMonthlySurplus: null,
        savingsRatePct: null,
        positiveCashFlowMonths: null,
        completedMonthsAnalyzed: 0,
      };
    }
    const avgSurplus = completedWithTx.reduce((s, m) => s + m.cashFlow, 0) / completedMonthsAnalyzed;
    const avgIncome = completedWithTx.reduce((s, m) => s + m.income, 0) / completedMonthsAnalyzed;
    return {
      available: true,
      avgMonthlySurplus: Math.round(avgSurplus),
      savingsRatePct: avgIncome > 0 ? Math.round((avgSurplus / avgIncome) * 100) : null,
      positiveCashFlowMonths: completedWithTx.filter((m) => m.cashFlow > 0).length,
      completedMonthsAnalyzed,
    };
  })();

  // ─── 5. Financial goal analysis (feasibility vs real capacity) ──
  const goalFeasibility = (() => {
    if (input.goals.length === 0) {
      return {
        available: false,
        reason: "Pengguna belum membuat tujuan keuangan.",
        items: [] as GoalFeasibilityItem[],
      };
    }
    const items = input.goals.map((g) => {
      const metrics = calculateGoalMetrics(
        {
          id: g.name,
          target_amount: g.targetAmount,
          current_savings: g.currentSavings,
          deadline: g.deadline,
          is_achieved: g.isAchieved,
        },
        now
      );
      const capacity = savingCapacity.avgMonthlySurplus;
      const feasible =
        g.requiredMonthlyContribution === null
          ? null
          : capacity === null
            ? null
            : capacity >= g.requiredMonthlyContribution;
      const monthsToFund =
        capacity !== null && capacity > 0 && metrics.remaining > 0
          ? Math.ceil(metrics.remaining / capacity)
          : null;
      let note: string;
      if (metrics.remaining === 0) {
        note = "Tujuan sudah tercapai.";
      } else if (metrics.isOverdue) {
        note = "Tenggat sudah terlewat dan tujuan belum tercapai.";
      } else if (feasible === null) {
        note = "Kapasitas menabung belum dapat dihitung — butuh riwayat transaksi bulan lengkap.";
      } else if (feasible) {
        note = `Tercapai dengan surplus bulanan saat ini (${rp(capacity ?? 0)}/bulan) dalam ${monthsToFund ?? "?"} bulan.`;
      } else {
        note = `Surplus bulanan saat ini (${rp(capacity ?? 0)}) belum cukup untuk setoran yang dibutuhkan (${rp(g.requiredMonthlyContribution ?? 0)}/bulan).`;
      }
      return {
        name: g.name,
        requiredMonthlyContribution: g.requiredMonthlyContribution,
        feasibleWithCurrentSurplus: feasible,
        monthsToFundAtCurrentCapacity: monthsToFund,
        note,
      };
    });
    return { available: true, items };
  })();

  // ─── 6. Basic financial forecasting ──────────────────────────
  const forecast: ForecastResult = (() => {
    if (completedMonthsAnalyzed < 2) {
      return {
        available: false,
        reason:
          "Proyeksi butuh minimal 2 bulan lengkap dengan transaksi tercatat. Data saat ini belum cukup — TIDAK ADA proyeksi yang boleh dibuat.",
        confidence: null,
        method: null,
        projectedIncome: null,
        projectedExpenses: null,
        projectedCashFlow: null,
      };
    }
    const recent = completedWithTx.slice(-3); // last up-to-3 completed months
    const n = recent.length;
    const projIncome = recent.reduce((s, m) => s + m.income, 0) / n;
    const projExpenses = recent.reduce((s, m) => s + m.expenses, 0) / n;
    return {
      available: true,
      confidence: n >= 3 ? "medium" : "low",
      method: `Rata-rata ${n} bulan lengkap terakhir (${recent[0].monthKey} s/d ${recent[n - 1].monthKey}). Proyeksi edukatif, bukan jaminan.`,
      projectedIncome: Math.round(projIncome),
      projectedExpenses: Math.round(projExpenses),
      projectedCashFlow: Math.round(projIncome - projExpenses),
    };
  })();

  // ─── 7. Financial health assessment ──────────────────────────
  const health: HealthScore = (() => {
    if (!incomeExpense.available || savingCapacity.avgMonthlySurplus === null) {
      return {
        available: false,
        reason:
          "Penilaian kesehatan keuangan butuh minimal 1 bulan lengkap transaksi tercatat. Isi juga Analisis Keuangan untuk hasil terbaik.",
        score: null,
        status: null,
        components: [],
      };
    }
    const components: { label: string; earned: number; max: number; note: string }[] = [];

    const avgIncome = incomeExpense.avgMonthlyIncome ?? 0;
    const rate = savingCapacity.savingsRatePct ?? 0;
    const savingsEarned = rate >= 20 ? 25 : rate >= 10 ? 15 : rate >= 0 ? 5 : 0;
    components.push({
      label: "Rasio tabungan aktual",
      earned: savingsEarned,
      max: 25,
      note: `Rata-rata ${rate}% dari pendapatan tersisa setiap bulan.`,
    });

    const discretionary = categories.items
      .filter((c) => !c.isEssential && !c.isDebtRelated)
      .reduce((s, c) => s + c.total, 0);
    const discretionaryShare =
      categories.totalExpenses > 0 ? (discretionary / categories.totalExpenses) * 100 : 0;
    const essentialEarned = discretionaryShare <= 30 ? 25 : discretionaryShare <= 50 ? 15 : 5;
    components.push({
      label: "Kontrol pengeluaran diskresioner",
      earned: essentialEarned,
      max: 25,
      note: `Pengeluaran non-kebutuhan pokok ${pctRound(discretionaryShare)}% dari total pengeluaran.`,
    });

    const cf = incomeExpense.avgMonthlyCashFlow ?? 0;
    const cfEarned = cf > 0 ? 25 : cf === 0 ? 10 : 0;
    components.push({
      label: "Arus kas bulanan",
      earned: cfEarned,
      max: 25,
      note: `Rata-rata arus kas ${rp(cf)} per bulan.`,
    });

    let maxPossible = 75;
    if (input.assessment) {
      maxPossible = 100;
      const ef = input.assessment.metrics.emergencyFundCoverage.value;
      const target = Math.min(6, 3 + input.assessment.input.financialDependents);
      const efEarned = ef >= target ? 25 : ef >= 1 ? 10 : 0;
      components.push({
        label: "Cakupan dana darurat",
        earned: efEarned,
        max: 25,
        note: `Dana darurat menutup ${ef} bulan (target ${target} bulan, dari asesmen).`,
      });
    }

    const score = Math.round(
      (components.reduce((s, c) => s + c.earned, 0) / maxPossible) * 100
    );
    const status: "good" | "warning" | "critical" =
      score >= 70 ? "good" : score >= 40 ? "warning" : "critical";
    return { available: true, score, status, components };
  })();

  // ─── 8. Personalized recommendations (rule-based) ────────────
  const recommendations: Recommendation[] = [];
  const push = (r: Recommendation) => recommendations.push(r);

  if (!incomeExpense.available) {
    push({
      id: "record_more_data",
      title: "Catat transaksi secara rutin",
      detail:
        "Belum ada bulan lengkap dengan transaksi tercatat, sehingga analisis pola pengeluaran, kapasitas menabung, dan proyeksi belum dapat dilakukan. Catat transaksi minimal satu bulan penuh agar analisis dapat berjalan.",
      basis: "completedMonthsAnalyzed = 0",
      priority: 1,
    });
  } else {
    const cf = incomeExpense.avgMonthlyCashFlow ?? 0;
    if (cf < 0) {
      push({
        id: "negative_cash_flow",
        title: "Perbaiki arus kas negatif",
        detail: `Rata-rata pengeluaran Anda melebihi pendapatan sebesar ${rp(Math.abs(cf))} per bulan. Kurangi pengeluaran pada kategori terbesar terlebih dahulu.`,
        basis: `avgMonthlyIncome=${incomeExpense.avgMonthlyIncome}, avgMonthlyExpenses=${incomeExpense.avgMonthlyExpenses}`,
        priority: 1,
      });
    }

    const topCat = categories.items[0];
    if (topCat && topCat.shareOfExpenses >= 30) {
      push({
        id: "top_category_dominant",
        title: `Tinjau pengeluaran ${topCat.category}`,
        detail: `${topCat.category} menyerap ${topCat.shareOfExpenses}% dari total pengeluaran ${WINDOW_MONTHS} bulan terakhir (${rp(topCat.total)}, rata-rata ${rp(topCat.monthlyAverage)}/bulan). Tetapkan anggaran bulanan untuk kategori ini.`,
        basis: `categoryTotal=${topCat.total}, share=${topCat.shareOfExpenses}%`,
        priority: 2,
      });
    }

    const rate = savingCapacity.savingsRatePct;
    if (rate !== null && rate < 10 && cf >= 0) {
      push({
        id: "low_savings_rate",
        title: "Tingkatkan rasio tabungan",
        detail: `Rata-rata hanya ${rate}% pendapatan yang tersisa. Target sehat: 20%. Mulai dengan menyisihkan tabungan di awal bulan, bukan dari sisa.`,
        basis: `savingsRatePct=${rate}, avgSurplus=${savingCapacity.avgMonthlySurplus}`,
        priority: 2,
      });
    }

    const exceeded = overspendingAlerts.filter((a) => a.kind === "budget_exceeded");
    if (exceeded.length > 0) {
      push({
        id: "budget_exceeded",
        title: "Patuhi anggaran yang sudah dibuat",
        detail: `${exceeded.length} anggaran terlampaui bulan ini: ${exceeded.map((a) => a.category).join(", ")}. Geser dana dari kategori fleksibel atau tunda pembelian non-urgen.`,
        basis: exceeded.map((a) => a.detail).join("; "),
        priority: 1,
      });
    }

    const spikes = overspendingAlerts.filter((a) => a.kind === "category_spike");
    if (spikes.length > 0) {
      push({
        id: "category_spike",
        title: "Periksa kenaikan pengeluaran",
        detail: spikes.map((a) => a.detail).join(" "),
        basis: "month-over-month category comparison",
        priority: 3,
      });
    }

    if (input.assessment) {
      const m = input.assessment.metrics;
      const efTarget = Math.min(6, 3 + input.assessment.input.financialDependents);
      if (m.emergencyFundCoverage.value < efTarget && savingCapacity.avgMonthlySurplus !== null) {
        const gap = Math.max(
          0,
          efTarget * input.assessment.input.essentialExpenses - input.assessment.input.emergencyFund
        );
        const monthsNeeded =
          savingCapacity.avgMonthlySurplus > 0
            ? Math.ceil(gap / savingCapacity.avgMonthlySurplus)
            : null;
        push({
          id: "emergency_fund",
          title: "Bangun dana darurat",
          detail:
            monthsNeeded !== null
              ? `Dana darurat Anda menutup ${m.emergencyFundCoverage.value} bulan (target ${efTarget} bulan). Dengan surplus ${rp(savingCapacity.avgMonthlySurplus)}/bulan, kekurangan ${rp(gap)} dapat terisi dalam ${monthsNeeded} bulan.`
              : `Dana darurat Anda menutup ${m.emergencyFundCoverage.value} bulan (target ${efTarget} bulan), namun surplus bulanan belum ada untuk menambahnya. Perbaiki arus kas terlebih dahulu.`,
          basis: `emergencyFundCoverage=${m.emergencyFundCoverage.value}, target=${efTarget}, gap=${gap}`,
          priority: 2,
        });
      }
      const dti = m.debtToIncomeRatio.value;
      if (dti > 30) {
        push({
          id: "high_dti",
          title: "Kurangi beban cicilan",
          detail: `Cicilan bulanan mencapai ${dti}% dari pendapatan (batas aman umum: 30%). Prioritaskan pelunasan utang berbunga tertinggi sebelum menambah pengeluaran lain.`,
          basis: `debtToIncomeRatio=${dti}% (asesmen)`,
          priority: 1,
        });
      }
    }

    if (goalFeasibility.available) {
      const infeasible = goalFeasibility.items.filter(
        (g) => g.feasibleWithCurrentSurplus === false
      );
      if (infeasible.length > 0) {
        push({
          id: "goals_infeasible",
          title: "Sesuaikan target atau tenggat tujuan",
          detail: `Surplus bulanan saat ini belum cukup untuk ${infeasible.length} tujuan: ${infeasible.map((g) => g.name).join(", ")}. Pertimbangkan memperpanjang tenggat, menurunkan target, atau menambah pemasukan.`,
          basis: "goal requiredMonthlyContribution vs avgMonthlySurplus",
          priority: 2,
        });
      }
    }

    if (cf > 0 && (rate ?? 0) >= 20 && overspendingAlerts.filter((a) => a.kind === "budget_exceeded").length === 0) {
      push({
        id: "allocate_surplus",
        title: "Manfaatkan surplus secara terencana",
        detail: `Arus kas Anda sehat (rata-rata surplus ${rp(cf)}/bulan, rasio tabungan ${rate}%). Alokasikan surplus ke dana darurat, pelunasan utang, atau tujuan keuangan yang tenggatnya paling dekat.`,
        basis: `avgCashFlow=${cf}, savingsRatePct=${rate}`,
        priority: 3,
      });
    }
  }

  recommendations.sort((a, b) => a.priority - b.priority);

  return {
    available: transactionsInWindow > 0,
    dataWindowMonths: WINDOW_MONTHS,
    months,
    completedMonthsAnalyzed,
    incomeExpense,
    categories,
    overspending,
    savingCapacity,
    goalFeasibility,
    forecast,
    health,
    recommendations: {
      available: recommendations.length > 0,
      items: recommendations,
    },
  };
}
