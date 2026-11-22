// Temporary smoke test for the Financial Intelligence Engine (run with tsx).
import { buildFinancialIntelligence } from "../supabase/functions/_shared/financial/intelligence.ts";
import type { IntelligenceTxRow } from "../supabase/functions/_shared/financial/intelligence.ts";

const now = new Date(2026, 10, 15); // Nov 15, 2026

// 4 completed months (Jun–Oct) + partial Nov.
const rows: IntelligenceTxRow[] = [];
const months: [number, number, number, number][] = [
  // [monthIndex(0=Jan), income, foodExpense, entertainmentExpense]
  [5, 5_000_000, 1_500_000, 500_000], // Jun
  [6, 5_000_000, 1_600_000, 700_000], // Jul
  [7, 5_000_000, 1_700_000, 900_000], // Aug
  [8, 6_000_000, 1_800_000, 1_200_000], // Sep
  [9, 6_000_000, 2_000_000, 1_400_000], // Oct
  [10, 6_000_000, 900_000, 300_000], // Nov (partial)
];
for (const [m, inc, food, fun] of months) {
  rows.push({ type: "income", category: "Gaji", amount: inc, transaction_date: `2026-${String(m + 1).padStart(2, "0")}-05` });
  rows.push({ type: "expense", category: "Makanan", amount: food, transaction_date: `2026-${String(m + 1).padStart(2, "0")}-10` });
  rows.push({ type: "expense", category: "Hiburan", amount: fun, transaction_date: `2026-${String(m + 1).padStart(2, "0")}-20` });
}

const result = buildFinancialIntelligence({
  transactions: rows,
  budgets: [
    { category: "Makanan", limitAmount: 1_500_000, spent: 900_000, percentage: 60 },
    { category: "Hiburan", limitAmount: 800_000, spent: 1_100_000, percentage: 138 },
  ],
  goals: [
    {
      name: "Dana Darurat",
      targetAmount: 12_000_000,
      currentSavings: 4_000_000,
      deadline: "2027-06-30",
      isAchieved: false,
      requiredMonthlyContribution: 888_889,
    },
  ],
  assessment: null,
  now,
});

const failures: string[] = [];
const expect = (cond: boolean, label: string) => {
  if (!cond) failures.push(label);
};

// Completed months = Jun..Oct = 5
expect(result.completedMonthsAnalyzed === 5, `completedMonthsAnalyzed=${result.completedMonthsAnalyzed}, expected 5`);

// Avg income of completed months: (5+5+5+6+6)M/5 = 5.4M
const ie = result.incomeExpense;
expect(ie.available && ie.avgMonthlyIncome === 5_400_000, `avgIncome=${ie.avgMonthlyIncome}, expected 5_400_000`);
// Avg expenses: (2+2.3+2.6+3+3.4)M/5 = 2.66M
expect(ie.available && ie.avgMonthlyExpenses === 2_660_000, `avgExpenses=${ie.avgMonthlyExpenses}, expected 2_660_000`);
// Avg cash flow: 5.4M-2.66M = 2.74M
expect(ie.available && ie.avgMonthlyCashFlow === 2_740_000, `avgCashFlow=${ie.avgMonthlyCashFlow}, expected 2_740_000`);
expect(ie.incomeTrend === "up" && ie.expenseTrend === "up", `trends=${ie.incomeTrend}/${ie.expenseTrend}, expected up/up`);

// Categories: Makanan total = 1.5+1.6+1.7+1.8+2+0.9 = 9.5M; share = 9.5/13.3 = 71.4% -> 71
const cats = result.categories;
const makanan = cats.items.find((c) => c.category === "Makanan");
expect(cats.totalExpenses === 13_300_000, `totalExpenses=${cats.totalExpenses}, expected 13_300_000`);
expect(makanan?.total === 9_500_000, `makanan total=${makanan?.total}, expected 9_500_000`);
expect(makanan?.shareOfExpenses === 71, `makanan share=${makanan?.shareOfExpenses}, expected 71`);
expect(makanan?.isEssential === true, "makanan should be essential");
const hiburan = cats.items.find((c) => c.category === "Hiburan");
expect(hiburan?.isEssential === false, "hiburan should be non-essential");
// Hiburan MoM: Oct 1.4M vs Sep 1.2M = +17%
expect(hiburan?.changePct === 17, `hiburan changePct=${hiburan?.changePct}, expected 17`);

// Overspending: Hiburan budget exceeded (critical), spike Oct vs Sep (1.4 vs 1.2 = +16.7% < 30%, no spike)
const alerts = result.overspending.alerts;
expect(alerts.some((a) => a.kind === "budget_exceeded" && a.category === "Hiburan"), "expected budget_exceeded for Hiburan");
expect(!alerts.some((a) => a.kind === "category_spike"), "expected no category_spike (increase below threshold)");

// Saving capacity: avg surplus 2.74M, rate = 2.74/5.4 = 50.7% -> 51
const sc = result.savingCapacity;
expect(sc.avgMonthlySurplus === 2_740_000, `surplus=${sc.avgMonthlySurplus}`);
expect(sc.savingsRatePct === 51, `savingsRate=${sc.savingsRatePct}, expected 51`);
expect(sc.positiveCashFlowMonths === 5, `positiveMonths=${sc.positiveCashFlowMonths}`);

// Forecast: last 3 completed months (Aug, Sep, Oct): income (5+6+6)/3=5.667M->5,666,667 rounds to 5_666_667
const fc = result.forecast;
expect(fc.available && fc.confidence === "medium", `forecast available=${fc.available}, confidence=${fc.confidence}`);
expect(fc.projectedIncome === 5_666_667, `projectedIncome=${fc.projectedIncome}, expected 5_666_667`);
expect(fc.projectedExpenses === 2_666_667, `projectedExpenses=${fc.projectedExpenses}, expected 2_666_667`);

// Health: no assessment -> max 75. savings rate 51>=20 ->25; discretionary share = 3.8/13.3=28.6%<=30 ->25; cf>0 ->25. score=75/75=100
const h = result.health;
expect(h.available && h.score === 100, `health score=${h.score}, expected 100`);
expect(h.status === "good", `health status=${h.status}`);

// Goal feasibility: required 888,889 <= 2,740,000 surplus -> feasible
const g = result.goalFeasibility.items[0];
expect(g.feasibleWithCurrentSurplus === true, `goal feasible=${g.feasibleWithCurrentSurplus}`);
expect(g.monthsToFundAtCurrentCapacity === Math.ceil(8_000_000 / 2_740_000), `monthsToFund=${g.monthsToFundAtCurrentCapacity}`);

// Recommendations exist and are priority-sorted
expect(result.recommendations.available, "recommendations should exist");
const priorities = result.recommendations.items.map((r) => r.priority);
expect(priorities.every((p, i) => i === 0 || p >= priorities[i - 1]), "recommendations should be sorted by priority");

if (failures.length > 0) {
  console.error("SMOKE TEST FAILED:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
} else {
  console.log("ALL SMOKE TESTS PASSED");
  console.log(JSON.stringify({
    completedMonthsAnalyzed: result.completedMonthsAnalyzed,
    incomeExpense: result.incomeExpense,
    savingCapacity: result.savingCapacity,
    forecast: result.forecast,
    health: result.health,
    alerts: result.overspending.alerts.length,
    recommendations: result.recommendations.items.map((r) => r.id),
  }, null, 2));
}
