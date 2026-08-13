-- FULL WIPE — clears every transactional/movement table, keeps:
--   products, lists, settings, recipes, recipe_ingredients,
--   purchase_lists, purchase_list_lines (the separate planning tool)
-- Run this once, deliberately. It is not reversible.

truncate table
  sale_lines, sales,
  purchase_lines, purchases,
  inventory_ledger, batch_cache, batches, inventory_cache,
  adjustments, waste, returns,
  physical_count_lines, physical_counts,
  kitchen_production, meal_unaccounted_log,
  purchase_recommendations, analytics_cache,
  pos_import_log, pos_unmatched_items, audit_log
cascade;

-- Every number sequence for the tables above, back to the start.
-- products_sku_seq and purchase_lists_number_seq are deliberately left
-- alone — those tables aren't being wiped, and resetting their sequences
-- would risk generating a duplicate number for something that already exists.
alter sequence purchases_number_seq restart with 1;
alter sequence sales_number_seq restart with 1;
alter sequence adjustments_number_seq restart with 1;
alter sequence returns_number_seq restart with 1;
alter sequence waste_number_seq restart with 1;
alter sequence batches_number_seq restart with 1;
alter sequence batch_fifo_seq restart with 1;
alter sequence physical_counts_number_seq restart with 1;
alter sequence production_number_seq restart with 1;
