import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CookUnityAPI } from "../services/api.js";
import {
  ListDeliveriesSchema,
  GetCartSchema,
  SkipDeliverySchema,
  UnskipDeliverySchema,
  NextDeliverySchema,
} from "../schemas/index.js";
import type {
  ListDeliveriesInput,
  GetCartInput,
  SkipDeliveryInput,
  UnskipDeliveryInput,
  NextDeliveryInput,
} from "../schemas/index.js";
import { ResponseFormat } from "../constants.js";
import { findDay, getNextMonday, formatDelivery, formatPrice, pickNextDelivery, sourceMeals, deliveryTotal, handleError, toStructured } from "../services/helpers.js";

export function registerDeliveryTools(server: McpServer, api: CookUnityAPI): void {
  server.registerTool(
    "cookunity_list_deliveries",
    {
      title: "List Upcoming CookUnity Deliveries",
      description: `List upcoming delivery weeks with full details: confirmed order items, cart contents, CookUnity auto-picks, skip/pause status, and cutoff deadlines.

IMPORTANT: Always call this tool to get FRESH data before answering any question about delivery status, meals, or orders. NEVER rely on cached or previously returned data — the user may have made changes on the website or app between calls.

Args:
  - response_format ('markdown'|'json')

Returns (JSON): { deliveries[{ date, status, meal_source ('order'|'cart'|'auto_picks'|'none'), can_edit, menu_available, cutoff, cutoff_timezone, cart_items[], cart_count, order, recommendation_items[] }] }

Examples:
  - See upcoming weeks: {}
  - Check what's in my carts: {}

Error Handling:
  - Auth errors suggest checking credentials`,
      inputSchema: ListDeliveriesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListDeliveriesInput) => {
      try {
        const days = await api.getUpcomingDays();
        // Filter to scheduled delivery days only
        const scheduledDays = days.filter((d) => d.scheduled);
        const deliveries = scheduledDays.map(formatDelivery);

        const output = { total: deliveries.length, deliveries };

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: toStructured(output) };
        }

        const lines = ["# Upcoming Deliveries", ""];
        for (const d of deliveries) {
          const statusEmoji = d.status === "active" ? "✅" : d.status === "skipped" ? "⏭️" : d.status === "paused" ? "⏸️" : "🔒";
          lines.push(`## ${d.date} ${statusEmoji} ${d.status.toUpperCase()}`);
          if (d.cutoff) lines.push(`**Cutoff**: ${d.cutoff} (${d.cutoff_timezone ?? ""})`);
          lines.push(`**Editable**: ${d.can_edit ? "Yes" : "No"} | **Menu available**: ${d.menu_available ? "Yes" : "No"}`);

          if (d.order) {
            lines.push(`**Order** #${d.order.id} (${d.order.status ?? "unknown"}, ${formatPrice(d.order.grand_total)}):`);
            for (const item of d.order.items) {
              lines.push(`  - ${item.name} x${item.quantity}, ${formatPrice(item.price)} (${item.chef ?? "chef unknown"})`);
            }
          } else if (d.cart_count > 0) {
            lines.push(`**Cart** (${d.cart_count} items):`);
            for (const item of d.cart_items) {
              lines.push(`  - ${item.name} x${item.quantity}, ${formatPrice(item.price)} (${item.chef ?? "chef unknown"})`);
            }
          } else if (d.recommendation_count > 0) {
            lines.push(`**CookUnity Picks** (${d.recommendation_count} meals — not yet confirmed):`);
            for (const item of d.recommendation_items) {
              lines.push(`  - ${item.name} x${item.quantity} (${item.chef ?? "chef unknown"})`);
            }
          } else {
            lines.push("**Meals**: None selected");
          }
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.registerTool(
    "cookunity_get_cart",
    {
      title: "Get CookUnity Cart",
      description: `Get cart contents for a specific delivery date. Always call fresh — NEVER use cached results.

Args:
  - date (string, optional): YYYY-MM-DD. Defaults to next Monday.
  - response_format ('markdown'|'json')

Returns (JSON): { date, can_edit, is_skipped, cutoff, meal_source ('order'|'cart'|'auto_picks'|'none'), items[{ name, inventory_id, quantity, price, chef }], total_items, total_price }

Note: Shows what will ship: the confirmed order's items, else the cart, else CookUnity's auto-picks (meal_source says which). Auto-picks carry no price.

Error Handling:
  - Returns "Date not found" if date is not in upcoming deliveries`,
      inputSchema: GetCartSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetCartInput) => {
      try {
        const date = params.date ?? getNextMonday();
        const days = await api.getUpcomingDays();
        const day = findDay(days, date);
        if (!day) {
          return { content: [{ type: "text", text: `Error: Date ${date} not found in upcoming deliveries. Use cookunity_list_deliveries to see available dates.` }], isError: true };
        }

        const delivery = formatDelivery(day);
        const items = sourceMeals(delivery);

        const output = {
          date: day.displayDate,
          can_edit: day.canEdit,
          is_skipped: day.skip,
          cutoff: day.cutoff?.time ?? null,
          meal_source: delivery.meal_source,
          items,
          total_items: items.reduce((s, i) => s + i.quantity, 0),
          total_price: deliveryTotal(delivery, items),
        };

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: toStructured(output) };
        }

        const lines = [`# Cart — ${output.date}`, `Status: ${day.skip ? "Skipped" : day.canEdit ? "Editable" : "Locked"}`, ""];
        if (delivery.meal_source === "none") {
          lines.push("Cart is empty, and there are no auto-picks.");
        } else {
          const labels = {
            order: `Confirmed order #${delivery.order?.id ?? ""}`,
            cart: "Cart (not confirmed)",
            auto_picks: "CookUnity auto-picks (not confirmed, ship at cutoff)",
          };
          lines.push(`**${labels[delivery.meal_source]}**`, "");
          for (const item of items) {
            lines.push(`- **${item.name}** x${item.quantity}, ${formatPrice(item.price)} (${item.chef ?? "chef unknown"})`);
          }
          lines.push("", `**Total**: ${output.total_items} items, ${formatPrice(output.total_price)}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.registerTool(
    "cookunity_skip_delivery",
    {
      title: "Skip CookUnity Delivery",
      description: `Skip a delivery week. IMPORTANT: Always call cookunity_list_deliveries first to get valid delivery dates — do NOT guess or calculate dates manually.

Args:
  - date (string, required): YYYY-MM-DD delivery date to skip (must match an actual delivery date from cookunity_list_deliveries)

Returns: Confirmation message with skip ID

Error Handling:
  - Invalid date: returns available delivery dates
  - Past cutoff: returns error suggesting checking cutoff with list_deliveries
  - Already skipped: returns API error`,
      inputSchema: SkipDeliverySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SkipDeliveryInput) => {
      try {
        // Validate date against actual upcoming deliveries
        const days = await api.getUpcomingDays();
        const validDates = days.map((d) => d.date);
        if (!validDates.includes(params.date)) {
          return { content: [{ type: "text", text: `Error: "${params.date}" is not a valid delivery date. Available dates: ${validDates.join(", ")}. Use cookunity_list_deliveries to see your delivery calendar.` }], isError: true };
        }
        const result = await api.skipDelivery(params.date);
        if (result.__typename === "OrderCreationError") {
          return { content: [{ type: "text", text: `Error: ${result.error ?? "Failed to skip delivery"}. Check cutoff with cookunity_list_deliveries.` }], isError: true };
        }
        const output = { success: true, date: params.date, skip_id: result.id, message: `Delivery for ${params.date} has been skipped.` };
        return { content: [{ type: "text", text: output.message }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.registerTool(
    "cookunity_unskip_delivery",
    {
      title: "Unskip CookUnity Delivery",
      description: `Unskip a previously skipped delivery week. IMPORTANT: Always call cookunity_list_deliveries first to get valid delivery dates — do NOT guess or calculate dates manually.

Args:
  - date (string, required): YYYY-MM-DD delivery date to unskip (must match an actual delivery date from cookunity_list_deliveries)

Returns: Confirmation message

Error Handling:
  - Invalid date: returns available delivery dates
  - Week not skipped: returns API error`,
      inputSchema: UnskipDeliverySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UnskipDeliveryInput) => {
      try {
        // Validate date against actual upcoming deliveries
        const days = await api.getUpcomingDays();
        const validDates = days.map((d) => d.date);
        if (!validDates.includes(params.date)) {
          return { content: [{ type: "text", text: `Error: "${params.date}" is not a valid delivery date. Available dates: ${validDates.join(", ")}. Use cookunity_list_deliveries to see your delivery calendar.` }], isError: true };
        }
        const result = await api.unskipDelivery(params.date);
        if (result.__typename === "OrderCreationError") {
          return { content: [{ type: "text", text: `Error: ${result.error ?? "Failed to unskip delivery"}.` }], isError: true };
        }
        const output = { success: true, date: params.date, message: `Delivery for ${params.date} has been unskipped.` };
        return { content: [{ type: "text", text: output.message }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );

  server.registerTool(
    "cookunity_next_delivery",
    {
      title: "Get Next CookUnity Delivery",
      description: `Get the nearest upcoming delivery with full details — including today's delivery if it hasn't been delivered yet.

This is the recommended tool when the user asks about "my next delivery", "upcoming meals", "what's coming", etc. It returns the closest scheduled (non-skipped) delivery with its confirmed order items, cart items, or CookUnity auto-picks.

IMPORTANT:
- "Next delivery" includes TODAY's delivery date. A delivery on today's date is still the "next" one unless it's already marked as completed/delivered.
- Always call this tool FRESH for every user question. NEVER use previously cached results — the user may have changed their order, skipped/unskipped, or edited their cart on the website between calls.

Args:
  - response_format ('markdown'|'json')

Returns: The nearest delivery with date, status, meal_source ('order'|'cart'|'auto_picks'|'none'), meals (from that source), and cutoff info.`,
      inputSchema: NextDeliverySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: NextDeliveryInput) => {
      try {
        const days = await api.getUpcomingDays();
        const next = pickNextDelivery(days);

        if (!next) {
          return { content: [{ type: "text", text: "No upcoming deliveries found. All scheduled deliveries may be skipped." }], isError: true };
        }

        const delivery = formatDelivery(next);
        const meals = sourceMeals(delivery);
        const sourceLabels = {
          order: `Confirmed order #${delivery.order?.id ?? ""} (${delivery.order?.status ?? "unknown"})`,
          cart: "Cart (NOT confirmed, will be replaced by CookUnity picks at cutoff)",
          auto_picks: "CookUnity auto-picks (not confirmed by user)",
          none: "No meals selected",
        };

        const output = {
          date: delivery.date,
          status: delivery.status,
          can_edit: delivery.can_edit,
          cutoff: delivery.cutoff,
          cutoff_timezone: delivery.cutoff_timezone,
          meal_source: delivery.meal_source,
          meal_source_label: sourceLabels[delivery.meal_source],
          meals,
          total_meals: meals.reduce((s, m) => s + m.quantity, 0),
          total_price: deliveryTotal(delivery, meals),
        };

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: toStructured(output) };
        }

        const lines = [`# Next Delivery: ${output.date}`, `**Status**: ${output.status} | **Editable**: ${output.can_edit ? "Yes" : "No"}`];
        if (output.cutoff) lines.push(`**Cutoff**: ${output.cutoff} (${output.cutoff_timezone ?? ""})`);
        lines.push(`**Source**: ${output.meal_source_label}`, "");
        if (meals.length === 0) {
          lines.push("No meals selected yet.");
        } else {
          for (const m of meals) {
            lines.push(`- **${m.name}** x${m.quantity}, ${formatPrice(m.price)} (${m.chef ?? "chef unknown"})`);
          }
          lines.push("", `**Total**: ${output.total_meals} meals, ${formatPrice(output.total_price)}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: toStructured(output) };
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
