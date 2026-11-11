import type { Meal, FormattedMeal, UpcomingDay, DeliveryInfo, DeliveryMealInfo, MealSource } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

export function getNextMonday(): string {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + daysUntilMonday);
  return nextMonday.toISOString().split("T")[0];
}

/** The one place that decides which of order, cart or auto-picks ships. */
export function mealSource(day: UpcomingDay): MealSource {
  if (day.order?.items?.length) return "order";
  if (day.cart?.length) return "cart";
  if (day.recommendation?.meals?.length) return "auto_picks";
  return "none";
}

export function sourceMeals(delivery: DeliveryInfo): DeliveryMealInfo[] {
  switch (delivery.meal_source) {
    case "order":
      return delivery.order?.items ?? [];
    case "cart":
      return delivery.cart_items;
    case "auto_picks":
      return delivery.recommendation_items;
    case "none":
      return [];
  }
}

/** A whitespace-only last name means a one-name chef (a restaurant). */
export function chefName(meal: { name?: string | null; chef_firstname?: string | null; chef_lastname?: string | null }): string {
  const first = (meal.chef_firstname ?? "").trim();
  if (!first) throw new Error(`Meal "${meal.name ?? "unknown"}" has no chef first name`);
  const last = (meal.chef_lastname ?? "").trim();
  return last ? `${first} ${last}` : first;
}

export function formatPrice(price: number | null): string {
  return price === null ? "price unknown" : `$${price.toFixed(2)}`;
}

/** Null when any price is unknown, so a partial sum is never shown as a total. */
export function totalPrice(meals: DeliveryMealInfo[]): number | null {
  let total = 0;
  for (const meal of meals) {
    if (meal.price === null) return null;
    total += meal.price * meal.quantity;
  }
  return total;
}

/** Today's date in the delivery timezone, as YYYY-MM-DD. */
export function todayInNewYork(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * A confirmed order's total is its grand total (fees and taxes included), never the sum of its
 * pre-tax item prices; null when CookUnity omits it.
 */
export function deliveryTotal(delivery: DeliveryInfo, meals: DeliveryMealInfo[]): number | null {
  return delivery.meal_source === "order" ? delivery.order?.grand_total ?? null : totalPrice(meals);
}

/** upcomingDays returns meal ids as strings ("1091"); the price breakdown accepts only integers. */
export function entityIdOf(id: unknown, mealName: string): number {
  const entityId = typeof id === "string" && id.trim() !== "" ? Number(id) : typeof id === "number" ? id : Number.NaN;
  if (!Number.isInteger(entityId) || entityId <= 0) throw new Error(`Meal "${mealName}" has no usable meal id (${String(id)})`);
  return entityId;
}

/**
 * A date can name a scheduled delivery by its Sunday menu key and an unscheduled slot by its
 * display date at once, so the scheduled day wins.
 */
export function findDay(days: UpcomingDay[], date: string): UpcomingDay | undefined {
  const matches = days.filter((day) => day.date === date || day.displayDate === date);
  return matches.find((day) => day.scheduled) ?? matches[0];
}

/** Compares displayDate (the delivery day the site shows), not the Sunday menu key in `date`. */
export function pickNextDelivery(days: UpcomingDay[], now: Date = new Date()): UpcomingDay | undefined {
  const today = todayInNewYork(now);
  return days
    .filter((day) => day.scheduled && !day.skip && day.displayDate >= today)
    .sort((earlier, later) => earlier.displayDate.localeCompare(later.displayDate))[0];
}

export function formatMeal(meal: Meal): FormattedMeal {
  return {
    id: meal.id,
    name: meal.name,
    description: meal.shortDescription,
    chef: `${meal.chef.firstName} ${meal.chef.lastName}`,
    category: meal.category.title,
    price: meal.finalPrice,
    original_price: meal.price,
    rating: meal.userRating,
    inventory_id: meal.inventoryId,
    batch_id: meal.batchId,
    in_stock: meal.stock > 0,
    stock: meal.stock,
    is_new: meal.isNewMeal,
    image: meal.image,
    nutrition: meal.nutritionalFacts,
    tags: {
      cuisines: meal.searchBy.cuisines,
      diet_tags: meal.searchBy.dietTags,
      protein_tags: meal.searchBy.proteinTags,
      ingredients: meal.searchBy.ingredients,
    },
    meat_type: meal.meatType,
  };
}

export function formatDelivery(day: UpcomingDay): DeliveryInfo {
  const status = !day.canEdit
    ? "locked"
    : day.skip
      ? "skipped"
      : day.isPaused
        ? "paused"
        : "active";

  const source = mealSource(day);
  // Only the list that ships must name its chefs; a stale list beside it (the auto-picks left
  // behind a confirmed order) shows an unusable chef as null instead of failing the whole day.
  const chefFor = (listSource: MealSource, meal: Parameters<typeof chefName>[0]): string | null => {
    if (listSource === source) return chefName(meal);
    try { return chefName(meal); } catch { return null; }
  };

  const cartItems = (day.cart || []).map((c) => ({
    name: c.product?.name ?? "Unknown",
    inventory_id: c.product?.inventoryId ?? "",
    quantity: c.qty,
    price: c.product?.price_incl_tax ?? null,
    chef: chefFor("cart", { ...c.product }),
  }));

  const orderInfo = day.order && day.order.items?.length > 0
    ? {
        id: day.order.id,
        status: day.order.orderStatus?.status ?? null,
        grand_total: day.order.grandTotal ?? null,
        items: day.order.items.map((item) => ({
          name: item.product?.name ?? "Unknown",
          inventory_id: item.product?.inventoryId ?? "",
          quantity: item.qty,
          price: item.price?.price ?? null,
          chef: chefFor("order", { ...item.product }),
        })),
        item_count: day.order.items.reduce((sum, i) => sum + (i.qty || 0), 0),
      }
    : null;

  const recMeals = day.recommendation?.meals || [];
  const recommendationItems = recMeals.map((m) => ({
    name: m.name ?? "Unknown",
    inventory_id: m.inventoryId ?? "",
    quantity: m.qty ?? 1,
    price: null,
    chef: chefFor("auto_picks", m),
  }));

  return {
    date: day.displayDate,
    status,
    meal_source: source,
    can_edit: day.canEdit,
    menu_available: day.menuAvailable,
    cutoff: day.cutoff?.time ?? null,
    cutoff_timezone: day.cutoff?.userTimeZone ?? null,
    cart_items: cartItems,
    cart_count: cartItems.reduce((sum, c) => sum + (c.quantity || 0), 0),
    order: orderInfo,
    recommendation_items: recommendationItems,
    recommendation_count: recommendationItems.reduce((sum, r) => sum + (r.quantity || 0), 0),
  };
}

export function formatMealMarkdown(m: FormattedMeal): string {
  const lines = [
    `### ${m.name}${m.is_new ? " 🆕" : ""}`,
    `**Chef**: ${m.chef} | **Category**: ${m.category}`,
    `**Price**: $${m.price.toFixed(2)}${m.price !== m.original_price ? ` (was $${m.original_price.toFixed(2)})` : ""} | **Rating**: ${m.rating}/5`,
    `**Stock**: ${m.in_stock ? m.stock : "Out of stock"} | **Inventory ID**: \`${m.inventory_id}\``,
    m.description,
    `🥩 ${m.meat_type} | ${m.nutrition.calories} cal`,
  ];
  if (m.tags.diet_tags.length > 0) lines.push(`🏷️ ${m.tags.diet_tags.join(", ")}`);
  return lines.join("\n");
}

export function truncateIfNeeded<T>(items: T[], textContent: string): { items: T[]; truncated: boolean; message?: string } {
  if (textContent.length <= CHARACTER_LIMIT) return { items, truncated: false };
  const reduced = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
  return {
    items: reduced,
    truncated: true,
    message: `Response truncated from ${items.length} to ${reduced.length} items. Use offset/limit or filters to see more.`,
  };
}

// Type for tool call results compatible with MCP SDK
interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function handleError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function toStructured(obj: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}
