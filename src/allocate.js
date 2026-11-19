const EPSILON = 1e-9;

/**
 * Weighted max-min fair share.
 * Each item: { demand, weight, floor }.
 * Floors are granted first (usage already committed cannot be reclaimed);
 * the remaining budget is distributed by weight, capped at demand, with
 * leftovers redistributed iteratively.
 *
 * @param {number} available budget to distribute
 * @param {Array<{demand:number, weight:number, floor:number}>} items
 * @returns {number[]} grant per item, same order
 */
export function weightedFairShare(available, items) {
  const budget = Math.max(0, available);
  const grants = items.map((item) => Math.min(Math.max(0, item.floor), item.demand));
  let remaining = budget - grants.reduce((sum, grant) => sum + grant, 0);

  if (remaining < 0) {
    // Floors alone exceed the budget: scale floors proportionally and let the
    // caller surface a shortfall diagnostic.
    const totalFloor = grants.reduce((sum, grant) => sum + grant, 0);
    const scale = totalFloor > 0 ? budget / totalFloor : 0;
    return grants.map((grant) => grant * scale);
  }

  let active = items
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => item.weight > 0 && item.demand > grants[index] + EPSILON);

  let guard = 0;
  while (remaining > EPSILON && active.length > 0 && guard < 10_000) {
    guard += 1;
    const totalWeight = active.reduce((sum, { item }) => sum + item.weight, 0);
    if (totalWeight <= EPSILON) break;
    let distributed = 0;
    const stillHungry = [];
    for (const { item, index } of active) {
      const share = remaining * (item.weight / totalWeight);
      const room = item.demand - grants[index];
      const grant = Math.min(share, room);
      grants[index] += grant;
      distributed += grant;
      if (room - grant > EPSILON) stillHungry.push({ item, index });
    }
    if (distributed <= EPSILON) break;
    remaining -= distributed;
    active = stillHungry;
  }
  return grants;
}
