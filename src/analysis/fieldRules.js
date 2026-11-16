// Which rule set each car in the field runs under, from Car Telemetry 2's per-car regulations2026 flag: the 2026 cars
// have active aero and Overtake mode, the 2025 cars DRS. An online lobby can hold both. cars: entries with regs2026
// (true, false, or null when the game has not said). `mixed` only when both sets are really in the field.
function fieldRules(cars) {
  const list = cars || [];
  const cars2026 = list.filter((c) => c.regs2026 === true).length;
  const cars2025 = list.filter((c) => c.regs2026 === false).length;
  return { cars2026, cars2025, unknown: list.length - cars2026 - cars2025, mixed: cars2026 > 0 && cars2025 > 0 };
}

module.exports = { fieldRules };
