import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CookUnityAPI } from "../services/api.js";
import { GetPriceBreakdownSchema } from "../schemas/index.js";
import type { GetPriceBreakdownInput } from "../schemas/index.js";
import type { MealInput } from "../types.js";
import { ResponseFormat } from "../constants.js";
import { entityIdOf, findDay, getNextMonday, mealSource, handleError, toStructured } from "../services/helpers.js";

export function registerPricingTools(server: McpServer, api: CookUnityAPI): void {
  server.registerTool(
    "cookunity_get_price_breakdown",
    {
      title: "Get CookUnity Price Breakdown",
      description: `Get a full price breakdown for a delivery including subtotal, taxes, delivery fee, discounts, and total.

Args:
  - date (string, optional): YYYY-MM-DD delivery date. Defaults to next Monday.
  - meals (array, optional): Meals to price, each with entityId, quantity, inventoryId. If omitted, prices what will ship: the confirmed order's items, else the cart, else CookUnity's auto-picks.
  - response_format ('markdown'|'json'): Output format

Returns (JSON): { date, subtotal, taxes, delivery_fee, express_fee, promo_discount, total, total_after_credits, available_credits, qty_plan_meals, qty_items, total_extra_meals }

Returns (Markdown): Formatted order summary with line items and total.

Examples:
  - Current cart: { date: "2026-02-23" }
  - Specific meals: { date: "2026-02-23", meals: [{ entityId: 12272, quantity: 1, inventoryId: "ii-135055242" }] }

Error Handling:
  - If no meals provided and there is no order, cart or auto-picks, returns error suggesting to add meals first
  - Invalid meal IDs return API error`,
      inputSchema: GetPriceBreakdownSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetPriceBreakdownInput) => {
      try {
        const date = params.date ?? getNextMonday();
        let meals: MealInput[];

        if (params.meals && params.meals.length > 0) {
          meals = params.meals.map((m) => ({
            entityId: m.entityId,
            quantity: m.quantity,
            inventoryId: m.inventoryId,
          }));
        } else {
          const days = await api.getUpcomingDays();
          const day = findDay(days, date);
          const source = day ? mealSource(day) : "none";
          if (!day || source === "none") {
            return {
              content: [{
                type: "text" as const,
                text: `No meals in the order, cart or auto-picks for ${date}. Add meals with cookunity_add_to_cart first, or pass meals directly to this tool.`,
              }],
              isError: true,
            };
          }
          if (source === "auto_picks") {
            // Auto-picks carry no meal id in upcomingDays, so take it from the menu by inventoryId.
            // The menu is keyed by the Sunday date, whichever date the caller passed.
            const menu = await api.getMenu(day.date);
            const idByInventory = new Map(menu.meals.map((meal) => [meal.inventoryId, meal.id]));
            meals = (day.recommendation?.meals ?? []).map((pick) => {
              const menuId = idByInventory.get(pick.inventoryId);
              if (menuId === undefined) {
                throw new Error(`Auto-pick "${pick.name}" is not on the ${day.date} menu, so its meal id is unknown. Pass meals directly.`);
              }
              return { entityId: entityIdOf(menuId, pick.name), quantity: pick.qty, inventoryId: pick.inventoryId };
            });
          } else {
            const entries = source === "order"
              ? (day.order?.items ?? []).map((item) => ({ product: item.product, qty: item.qty }))
              : day.cart;
            meals = entries.map((entry) => ({
              entityId: entityIdOf(entry.product.id, entry.product.name),
              quantity: entry.qty,
              inventoryId: entry.product.inventoryId,
            }));
          }
        }

        const breakdown = await api.getPriceBreakdown(date, meals);

        const output = {
          date,
          qty_plan_meals: breakdown.qtyPlanMeals,
          qty_items: breakdown.qtyItems,
          subtotal: breakdown.subTotalOrder,
          total_extra_meals: breakdown.totalExtraMeals,
          taxes: breakdown.totalTaxes,
          delivery_fee: breakdown.totalDeliveryFee,
          express_fee: breakdown.totalExpressFee,
          promo_discount: breakdown.totalPromoDiscount,
          total: breakdown.totalOrder,
          available_credits: breakdown.availableCredits,
          total_after_credits: breakdown.totalOrderWithCreditsSubtracted,
        };

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# Order Summary — ${date}`,
            "",
            `| Item | Amount |`,
            `|------|--------|`,
            `| Included in plan (${output.qty_plan_meals} meals) | $${output.subtotal.toFixed(2)} |`,
          ];
          if (output.total_extra_meals > 0) {
            lines.push(`| Extra meals | $${output.total_extra_meals.toFixed(2)} |`);
          }
          if (output.promo_discount > 0) {
            lines.push(`| Discount | -$${output.promo_discount.toFixed(2)} |`);
          }
          lines.push(`| Delivery fee | $${output.delivery_fee.toFixed(2)} |`);
          if (output.express_fee > 0) {
            lines.push(`| Express fee | $${output.express_fee.toFixed(2)} |`);
          }
          lines.push(`| Taxes | $${output.taxes.toFixed(2)} |`);
          lines.push(`|--------|--------|`);
          lines.push(`| **ORDER TOTAL** | **$${output.total.toFixed(2)}** |`);
          if (output.available_credits > 0) {
            lines.push("");
            lines.push(`Credits available: $${output.available_credits.toFixed(2)}`);
            lines.push(`Total after credits: $${output.total_after_credits.toFixed(2)}`);
          }
          text = lines.join("\n");
        }

        return { content: [{ type: "text", text }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
