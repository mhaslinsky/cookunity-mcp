import assert from "node:assert/strict";
import { test } from "node:test";
import { chefName, deliveryTotal, entityIdOf, findDay, formatDelivery, formatPrice, mealSource, pickNextDelivery, sourceMeals } from "./helpers.js";
import type { UpcomingDay } from "../types.js";

const pick = { name: "Auto Bowl", inventoryId: "ii-1", chef_firstname: "Ana", chef_lastname: "Ruiz", meat_type: null, qty: 1 };
const cartEntry = { qty: 2, product: { id: "10", inventoryId: "ii-2", name: "Cart Bowl", price_incl_tax: 11.5, chef_firstname: "Bo", chef_lastname: "Lee" } };
const orderItem = { qty: 1, price: { price: 12 }, product: { id: "11", inventoryId: "ii-3", name: "Order Bowl", chef_firstname: "Cy", chef_lastname: "Day" } };

function day(fields: Record<string, unknown>): UpcomingDay {
  return { date: "2026-11-15", displayDate: "2026-11-16", scheduled: true, skip: false, cart: [], order: null, recommendation: null, ...fields } as unknown as UpcomingDay;
}

test("a confirmed order wins over the auto-picks left beside it", () => {
  const confirmed = day({ order: { id: "9", grandTotal: 30, items: [orderItem] }, recommendation: { meals: [pick] } });
  assert.equal(mealSource(confirmed), "order");
});

test("the cart wins over auto-picks", () => {
  assert.equal(mealSource(day({ cart: [cartEntry], recommendation: { meals: [pick] } })), "cart");
});

test("auto-picks ship when the order and cart are empty", () => {
  assert.equal(mealSource(day({ recommendation: { meals: [pick] } })), "auto_picks");
});

test("no order, cart or auto-picks is none", () => {
  assert.equal(mealSource(day({ order: { id: "9", grandTotal: 0, items: [] }, recommendation: { meals: [] } })), "none");
});

test("a confirmed order is totalled by its grand total, and a stale auto-pick cannot break it", () => {
  const stalePick = { ...pick, chef_firstname: "  " };
  const confirmed = formatDelivery(day({ order: { id: "9", grandTotal: 30, items: [orderItem] }, recommendation: { meals: [stalePick] } }));
  assert.equal(deliveryTotal(confirmed, sourceMeals(confirmed)), 30);
  assert.equal(confirmed.recommendation_items[0]!.chef, null);
  const noTotal = formatDelivery(day({ order: { id: "9", grandTotal: null, items: [orderItem] } }));
  assert.equal(deliveryTotal(noTotal, sourceMeals(noTotal)), null);
});

test("an auto-pick week has no known prices, so its total is null, not $0.00", () => {
  const picks = formatDelivery(day({ recommendation: { meals: [pick] } }));
  assert.equal(deliveryTotal(picks, sourceMeals(picks)), null);
  assert.equal(formatPrice(null), "price unknown");
});

test("a cart with one unpriced item has a null total, never a partial sum", () => {
  const unpriced = { ...cartEntry, product: { ...cartEntry.product, price_incl_tax: null } };
  const priced = formatDelivery(day({ cart: [cartEntry] }));
  assert.equal(deliveryTotal(priced, sourceMeals(priced)), 23);
  const mixed = formatDelivery(day({ cart: [cartEntry, unpriced] }));
  assert.equal(deliveryTotal(mixed, sourceMeals(mixed)), null);
});

test("meal ids arrive as strings and leave as integers; a missing id is refused", () => {
  assert.equal(entityIdOf("1091", "Order Bowl"), 1091);
  assert.throws(() => entityIdOf(null, "Order Bowl"), /Order Bowl/);
  assert.throws(() => entityIdOf("", "Order Bowl"), /Order Bowl/);
});

test("chef names: two names, one name, blank first name", () => {
  assert.equal(chefName({ chef_firstname: "Ana", chef_lastname: "Ruiz" }), "Ana Ruiz");
  assert.equal(chefName({ chef_firstname: "Livy's All Day Cafe", chef_lastname: "     " }), "Livy's All Day Cafe");
  assert.throws(() => chefName({ name: "Mystery Stew", chef_firstname: "  ", chef_lastname: "Ruiz" }), /Mystery Stew/);
});

test("a date that is both a delivery's menu key and an unscheduled slot's display date finds the delivery", () => {
  // Live on Nov 11: the unscheduled Sunday slot shown as Nov 15 comes before the Nov 16 delivery keyed 2026-11-15.
  const unscheduledSunday = day({ date: "2026-11-15", displayDate: "2026-11-15", scheduled: false });
  const delivery = day({});
  assert.equal(findDay([unscheduledSunday, delivery], "2026-11-15"), delivery);
  assert.equal(findDay([unscheduledSunday, delivery], "2026-11-16"), delivery);
});

test("next delivery compares displayDate in New York time", () => {
  const upcoming = day({});
  const past = day({ date: "2026-11-08", displayDate: "2026-11-09" });
  assert.equal(pickNextDelivery([past, upcoming], new Date("2026-11-11T15:00:00Z")), upcoming);
  assert.equal(pickNextDelivery([past], new Date("2026-11-11T15:00:00Z")), undefined);
  // Monday delivery day: the Sunday key is already behind today, the display date is not.
  assert.equal(pickNextDelivery([upcoming], new Date("2026-11-16T15:00:00Z")), upcoming);
  // 9 PM ET on Nov 15 is already Nov 16 in UTC; it is still the 15th in New York.
  assert.equal(pickNextDelivery([day({ date: "2026-11-14", displayDate: "2026-11-15" })], new Date("2026-11-16T02:00:00Z"))?.displayDate, "2026-11-15");
});
